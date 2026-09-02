// @ts-nocheck
import sp from "@/assets/spine/spine-webgl";

// ============================================================
// 日志桥接：spine.ts 不能 import Vue 模块，通过 window.electronAPI 发日志
// ============================================================
let _spineLogLastError = 0;
function spineLog(level: string, message: string, data?: unknown): void {
  try {
    const api = (window as any).electronAPI;
    if (api?.log) {
      // render 异常限频：每 10s 最多记一条 ERROR
      if (level === 'ERROR' || level === 'WARN') {
        const now = Date.now();
        if (now - _spineLogLastError < 10000) return;
        _spineLogLastError = now;
      }
      api.log(level, 'Spine', message, data);
    }
  } catch { /* 日志失败不影响渲染 */ }
}

interface SkeletonData {
  skeleton: sp.Skeleton;
  bounds: { offset: sp.Vector2; size: sp.Vector2 };
  state: sp.AnimationState;
  premultipliedAlpha: boolean;
  repeatListener?: sp.AnimationStateListener;
  /** 资源路径，用于清理时释放 */
  skelPath: string;
  atlasPath: string;
  /** 此骨架在 assetManager 中加载的所有 key（含纹理页），用于精确清理 */
  assetKeys: string[];
}

interface Position {
  x: number;
  y: number;
  scale: number;
}

export class Spine {
  private skeletons: Record<string, SkeletonData> = {};
  private canvas: HTMLCanvasElement;
  private shader: sp.webgl.Shader;
  private batcher: sp.webgl.PolygonBatcher;
  private mvp: sp.webgl.Matrix4;
  private skeletonRenderer: sp.webgl.SkeletonRenderer;
  private context: sp.webgl.ManagedWebGLRenderingContext;
  private assetManager: sp.webgl.AssetManager;
  private lastFrameTime = 0;
  private activeSkeleton?: string;
  /** 预绑定的 render 函数，避免每帧 new Function */
  private boundRender: () => void;
  /** 目标帧间隔（秒），默认 30fps ≈ 0.033s；0 = 无上限 */
  private frameInterval = 1 / 30;
  /** 当前帧率设定值（用于展示） */
  frameRateSetting = 30;
  /** 渲染循环是否活跃（false = 暂停，不会调度下一帧） */
  private renderLoopActive = false;
  /** context 是否已丢失（丢失后不再尝试渲染） */
  private contextLost = false;
  /** context lost 事件的回调引用，用于 cleanup */
  private onContextLost: ((e: Event) => void) | null = null;
  private onContextRestored: ((e: Event) => void) | null = null;

  bg: [number, number, number, number] = [0, 0, 0, 0];
  position: Position = { x: 0, y: 0, scale: 1 };

  constructor(canvas: HTMLCanvasElement, gpuVendor?: string) {
    this.canvas = canvas;
    // AMD 核显的 D3D11 驱动在高性能模式下不稳定，使用默认调度
    // NVIDIA/Intel/未知 → 优先使用独显，避免回退到核显造成性能问题
    const pref = gpuVendor === 'amd' ? 'default' : 'high-performance';
    this.context = new sp.webgl.ManagedWebGLRenderingContext(canvas, {
      alpha: true,
      premultipliedAlpha: true,
      powerPreference: pref,
    });
    spineLog('INFO', 'Spine 实例创建', {
      canvasSize: `${canvas.width}x${canvas.height}`,
      gpuVendor: gpuVendor || 'unknown',
      powerPreference: pref,
    });
    this.shader = sp.webgl.Shader.newTwoColoredTextured(this.context);
    this.batcher = new sp.webgl.PolygonBatcher(this.context);
    this.mvp = new sp.webgl.Matrix4();
    this.mvp.ortho2d(0, 0, canvas.width, canvas.height);
    this.skeletonRenderer = new sp.webgl.SkeletonRenderer(this.context);
    this.assetManager = new sp.webgl.AssetManager(this.context);
    // 预绑定，避免每帧 new Function 造成 GC 压力
    this.boundRender = this.render.bind(this);

    // ============================================================
    // WebGL 上下文丢失/恢复处理
    // ============================================================
    this.onContextLost = (e: Event) => {
      e.preventDefault();
      this.contextLost = true;
      this.renderLoopActive = false;
      console.warn("[Spine] WebGL context lost — 渲染已暂停");
      spineLog('WARN', 'WebGL context lost');
    };
    this.onContextRestored = () => {
      this.contextLost = false;
      console.log("[Spine] WebGL context restored — 可恢复渲染");
      spineLog('INFO', 'WebGL context restored');
      // 上下文恢复后需要重新创建所有 GPU 资源
      // 最简单的做法是通知上层重新加载模型
      if (this.activeSkeleton) {
        // 尝试恢复渲染
        this.renderLoopActive = true;
        this.lastFrameTime = Date.now() / 1000;
        requestAnimationFrame(this.boundRender);
      }
    };
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
  }

  async load(
    name: string,
    skelPath: string,
    atlasPath: string,
    position: Position,
    skinName?: string,
    premultipliedAlpha = true
  ): Promise<SkeletonData> {
    if (this.skeletons[name]) return this.skeletons[name];

    spineLog('INFO', '开始加载模型', { name, skel: skelPath.slice(-50), atlas: atlasPath.slice(-50) });

    // 尝试走本地缓存（透明降级）
    const { skel, atlas } = await this.resolveCachePaths(name, skelPath, atlasPath);

    const usedCache = skel.startsWith('asset-cache://');
    spineLog('DEBUG', '资源路径解析完成', { name, usedCache });

    // 快照当前 assetManager 中的所有 key，加载后计算增量
    const prevKeys = this.snapshotAssetKeys();

    try {
      await this.fetchAssets(skel, atlas);
    } catch (e: any) {
      spineLog('ERROR', 'fetchAssets 失败', { name, skel: skel.slice(-80), atlas: atlas.slice(-80), error: e?.message || String(e) });
      throw e;
    }

    // 计算新加载的 asset key（含纹理页）
    const newKeys = this.computeNewAssetKeys(prevKeys);

    const result = this.loadSkel(name, skel, atlas, position, premultipliedAlpha, skinName, newKeys);
    spineLog('INFO', '模型加载完成', { name, animCount: result.skeleton.data.animations?.length || 0 });
    return result;
  }

  /**
   * 如果 electronAPI 缓存可用，将 CDN URL 替换为本地 asset-cache:// URL
   * 失败时静默回退原始 URL
   */
  private async resolveCachePaths(
    name: string,
    skelPath: string,
    atlasPath: string
  ): Promise<{ skel: string; atlas: string }> {
    const api = (window as any).electronAPI as ElectronAPI | undefined;
    if (!api?.cachePrepare) {
      return { skel: skelPath, atlas: atlasPath }; // 非 Electron 环境
    }

    // 从 name 提取角色 ID（name 格式: "char_2025_shu-默认-正面"）
    const charId = name.split("-")[0];

    try {
      const result = await api.cachePrepare(charId, skelPath, atlasPath);
      if (result) {
        return result;
      }
    } catch {
      // 缓存失败 → 回退 CDN
    }
    return { skel: skelPath, atlas: atlasPath };
  }

  /** 快照 assetManager 中已有的所有 key */
  private snapshotAssetKeys(): Set<string> {
    const assets = (this.assetManager as any).assets as Record<string, unknown>;
    return new Set(Object.keys(assets));
  }

  /** 计算快照后新增的 asset key */
  private computeNewAssetKeys(prevKeys: Set<string>): string[] {
    const assets = (this.assetManager as any).assets as Record<string, unknown>;
    return Object.keys(assets).filter((k) => !prevKeys.has(k));
  }

  private fetchAssets(skel: string, atlas: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // 检查资源是否已加载，避免重复下载 + 覆盖旧纹理不 dispose
      const skelKey = (this.assetManager as any).pathPrefix + skel;
      const atlasKey = (this.assetManager as any).pathPrefix + atlas;
      const assets = (this.assetManager as any).assets as Record<string, unknown>;

      const hasSkel = skelKey in assets && assets[skelKey] != null;
      const hasAtlas = atlasKey in assets && assets[atlasKey] != null;

      if (hasSkel && hasAtlas) {
        resolve();
        return;
      }

      let loaded = 0;
      const target = (hasSkel ? 0 : 1) + (hasAtlas ? 0 : 1);
      const checkDone = () => {
        loaded++;
        if (loaded >= target) resolve();
      };

      if (!hasSkel) {
        this.assetManager.loadBinary(
          skel,
          () => checkDone(),
          (path: string, err: string) => reject(err)
        );
      }

      if (!hasAtlas) {
        this.assetManager.loadTextureAtlas(
          atlas,
          () => checkDone(),
          (path: string, err: string) => reject(err)
        );
      }
    });
  }

  private loadSkel(
    name: string,
    skelPath: string,
    atlasPath: string,
    position: Position,
    premultipliedAlpha = true,
    skinName?: string,
    assetKeys?: string[]
  ): SkeletonData {
    const atlas = this.assetManager.get(atlasPath);
    const atlasLoader = new sp.AtlasAttachmentLoader(atlas);
    const skelData = this.assetManager.get(skelPath);
    let skeleton: sp.Skeleton;

    if (skelData[0] === 0x7b) {
      const skeletonJson = new sp.SkeletonJson(atlasLoader);
      const reader = new TextDecoder("utf-8");
      const data = skeletonJson.readSkeletonData(reader.decode(skelData));
      skeleton = new sp.Skeleton(data);
    } else {
      const skeletonBinary = new sp.SkeletonBinary(atlasLoader);
      const data = skeletonBinary.readSkeletonData(skelData);
      skeleton = new sp.Skeleton(data);
    }

    if (skinName) {
      try {
        skeleton.setSkinByName(skinName);
      } catch {
        console.warn(`Skin "${skinName}" not found in skeleton, using default`);
      }
    }

    const bounds = this.calculateBounds(skeleton);
    const animationStateData = new sp.AnimationStateData(skeleton.data);
    const animationState = new sp.AnimationState(animationStateData);

    this.mvp.ortho2d(
      position.x,
      position.y,
      this.canvas.width * position.scale,
      this.canvas.height * position.scale
    );

    const data: SkeletonData = {
      skeleton,
      bounds,
      state: animationState,
      premultipliedAlpha,
      skelPath,
      atlasPath,
      assetKeys: assetKeys || [skelPath, atlasPath],
    };

    this.skeletons[name] = data;
    this.position = position;
    return data;
  }

  private calculateBounds(skeleton: sp.Skeleton) {
    skeleton.setToSetupPose();
    skeleton.updateWorldTransform();
    const offset = new sp.Vector2();
    const size = new sp.Vector2();
    skeleton.getBounds(offset, size, []);
    return { offset, size };
  }

  /** 检查模型是否已加载 */
  hasModel(name: string): boolean {
    return !!this.skeletons[name];
  }

  /** 释放指定骨架及其 WebGL 纹理（含纹理页！） */
  removeSkeleton(name: string): void {
    const data = this.skeletons[name];
    if (!data) return;
    data.state.clearListeners();
    if (data.repeatListener) {
      data.state.removeListener(data.repeatListener);
      data.repeatListener = undefined;
    }

    // 释放此骨架加载的所有 assetManager 资源（含图集的纹理页）
    for (const key of data.assetKeys) {
      try {
        this.assetManager.remove(key);
      } catch {
        // 静默忽略重复释放等错误
      }
    }

    delete this.skeletons[name];
  }

  /** 清理除指定名称外的所有骨架，释放 GPU 内存 */
  cleanupExcept(keepName: string): void {
    const before = Object.keys(this.skeletons).length;
    for (const name of Object.keys(this.skeletons)) {
      if (name !== keepName) this.removeSkeleton(name);
    }
    const after = Object.keys(this.skeletons).length;
    if (before !== after) {
      spineLog('INFO', 'cleanupExcept', { keepName, removed: before - after, remaining: after });
    }
  }

  play(name: string): void {
    // 上下文丢失后拒绝渲染
    if (this.contextLost) return;

    // 已经是同一骨架且在渲染中，不重复启动
    if (this.renderLoopActive && name === this.activeSkeleton && this.lastFrameTime) return;

    this.lastFrameTime = Date.now() / 1000;
    this.activeSkeleton = name;

    // 启动渲染循环（如果尚未启动）
    if (!this.renderLoopActive) {
      this.renderLoopActive = true;
      requestAnimationFrame(this.boundRender);
    }
  }

  /** 暂停渲染循环（窗口隐藏时调用） */
  pause(): void {
    this.renderLoopActive = false;
  }

  /** 恢复渲染循环（窗口重新可见时调用） */
  resume(): void {
    if (this.contextLost) return;
    if (!this.activeSkeleton) return;
    if (this.renderLoopActive) return;
    this.renderLoopActive = true;
    this.lastFrameTime = Date.now() / 1000;
    requestAnimationFrame(this.boundRender);
  }

  /** 渲染循环是否在运行 */
  get isRendering(): boolean {
    return this.renderLoopActive;
  }

  private render(): void {
    // 暂停或上下文丢失 → 停止调度下一帧
    if (!this.renderLoopActive || this.contextLost || !this.activeSkeleton) {
      this.lastFrameTime = 0;
      return;
    }

    const now = Date.now() / 1000;
    const elapsed = now - this.lastFrameTime;

    // 帧率限制：无上限模式（frameInterval === 0）直接渲染，不跳帧
    if (this.frameInterval > 0 && elapsed < this.frameInterval) {
      requestAnimationFrame(this.boundRender);
      return;
    }

    const delta = Math.min(elapsed, 0.1); // cap delta 防止大跳帧
    this.lastFrameTime = now;

    try {
      this.context.gl.clearColor(...this.bg);
      this.context.gl.clear(this.context.gl.COLOR_BUFFER_BIT);

      const skel = this.skeletons[this.activeSkeleton];
      if (!skel) {
        requestAnimationFrame(this.boundRender);
        return;
      }

      const { state, skeleton, premultipliedAlpha } = skel;
      state.update(delta);
      state.apply(skeleton);
      skeleton.updateWorldTransform();

      this.shader.bind();
      this.shader.setUniformi(sp.webgl.Shader.SAMPLER, 0);
      this.shader.setUniform4x4f(sp.webgl.Shader.MVP_MATRIX, this.mvp.values);
      this.batcher.begin(this.shader);
      this.skeletonRenderer.premultipliedAlpha = premultipliedAlpha;
      this.skeletonRenderer.draw(this.batcher, skeleton);
      this.batcher.end();
      this.shader.unbind();
    } catch (e) {
      console.error("[Spine] Render error:", e);
      spineLog('ERROR', 'Render 异常', { error: (e as any)?.message || String(e), skeleton: this.activeSkeleton });
    }

    // FPS 采样回调（调试用）
    if ((this as any).__fpsCallback) {
      (this as any).__fpsCallback(elapsed * 1000);
    }

    // 调度下一帧（仅在 renderLoopActive 仍然为 true 时）
    if (this.renderLoopActive) {
      requestAnimationFrame(this.boundRender);
    }
  }

  getCurrent(): SkeletonData | undefined {
    if (!this.activeSkeleton) return undefined;
    return this.skeletons[this.activeSkeleton];
  }

  setAnimation(animationName: string, loop: boolean, onComplete?: () => void): void {
    if (!this.activeSkeleton) return;
    const skel = this.skeletons[this.activeSkeleton];
    if (!skel) return;

    spineLog('DEBUG', 'setAnimation', { anim: animationName, loop });
    const { state } = skel;
    // 清除旧监听器
    if (skel.repeatListener) {
      state.removeListener(skel.repeatListener);
      skel.repeatListener = undefined;
    }

    // 始终先设为非循环播放单次
    state.setAnimation(0, animationName, false);

    if (loop) {
      // 手动循环：每次 complete 时重新入队
      const listener: sp.AnimationStateListener = {
        start: () => {},
        interrupt: () => {},
        end: () => {},
        dispose: () => {},
        complete: () => {
          state.addAnimation(0, animationName, false, 0);
          onComplete?.();
        },
        event: () => {},
      };
      state.addListener(listener);
      skel.repeatListener = listener;
    } else if (onComplete) {
      // 单次播放 + 完成回调（自动移除）
      const listener: sp.AnimationStateListener = {
        start: () => {},
        interrupt: () => {},
        end: () => {},
        dispose: () => {},
        complete: () => {
          state.removeListener(listener);
          onComplete();
        },
        event: () => {},
      };
      state.addListener(listener);
    }
  }

  getAnimationList(): string[] {
    if (!this.activeSkeleton || !this.skeletons[this.activeSkeleton]) return [];
    return this.skeletons[this.activeSkeleton].skeleton.data.animations.map(
      (a: sp.Animation) => a.name
    );
  }

  /** 返回当前活跃骨架的所有动画名称（别名，语义更清晰） */
  getAnimationNames(): string[] {
    return this.getAnimationList();
  }

  move(x: number, y: number): void {
    if (!this.activeSkeleton) return;
    this.position.x = x;
    this.position.y = y;
    this.mvp.ortho2d(
      x,
      y,
      this.canvas.width / this.position.scale,
      this.canvas.height / this.position.scale
    );
  }

  scale(s: number): void {
    this.position.scale = s;
    this.mvp.ortho2d(
      this.position.x,
      this.position.y,
      this.canvas.width / s,
      this.canvas.height / s
    );
  }

  resize(width: number, height: number): void {
    this.canvas.width = width;
    this.canvas.height = height;
    this.mvp.ortho2d(
      this.position.x,
      this.position.y,
      width / this.position.scale,
      height / this.position.scale
    );
  }

  setSpeed(speed: number): void {
    const skel = this.getCurrent();
    if (skel) skel.state.timeScale = speed;
  }

  /**
   * 设置目标帧率
   * @param rate FPS（30 / 60 / 90 / 检测到的刷新率），0 = 无上限（不跳帧）
   */
  setFrameRate(rate: number): void {
    this.frameRateSetting = rate;
    this.frameInterval = rate > 0 ? 1 / rate : 0;
  }

  /** 获取 WebGL 上下文是否已丢失 */
  get isContextLost(): boolean {
    return this.contextLost;
  }

  /**
   * 读取画布指定坐标处的像素 alpha 值（0-255）
   * 坐标使用 canvas 内部坐标系（左上角为原点）
   * 用于判断鼠标下方是否有渲染的模型像素
   * @param x - canvas 内部坐标 X（非 CSS 坐标）
   * @param y - canvas 内部坐标 Y（非 CSS 坐标）
   * @returns alpha 通道值，0=完全透明，255=完全不透明
   */
  readPixelAlpha(x: number, y: number): number {
    const gl = this.context.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;

    // 边界检查
    if (x < 0 || x >= w || y < 0 || y >= h) return 0;

    // WebGL readPixels 原点在左下角，需要翻转 Y
    const flippedY = h - 1 - Math.round(y);
    const px = Math.round(x);

    const pixels = new Uint8Array(4);
    try {
      gl.readPixels(px, flippedY, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels[3]; // alpha channel
    } catch {
      // readPixels 可能在 context 丢失时抛出异常
      return 0;
    }
  }

  destroy(): void {
    spineLog('INFO', 'Spine destroy 开始', { skeletonCount: Object.keys(this.skeletons).length });
    // 停止渲染循环
    this.renderLoopActive = false;
    this.activeSkeleton = undefined;

    // 清理所有骨架及其 GPU 资源
    for (const name of Object.keys(this.skeletons)) {
      const data = this.skeletons[name];
      if (!data) continue;
      data.state.clearListeners();
      if (data.repeatListener) {
        data.state.removeListener(data.repeatListener);
        data.repeatListener = undefined;
      }
    }
    this.skeletons = {};

    // 释放所有 AssetManager 管理的 GPU 资源
    try {
      this.assetManager.removeAll();
    } catch {
      // 上下文可能已丢失，静默忽略
    }

    // 释放 WebGL 辅助对象
    try {
      this.batcher.dispose?.();
    } catch { /* ignore */ }
    try {
      this.shader.dispose?.();
    } catch { /* ignore */ }
    try {
      this.skeletonRenderer.dispose?.();
    } catch { /* ignore */ }

    // 移除 WebGL 上下文事件监听
    if (this.onContextLost) {
      this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
      this.onContextLost = null;
    }
    if (this.onContextRestored) {
      this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
      this.onContextRestored = null;
    }

    // 尝试释放 WebGL 上下文（让浏览器回收 GPU 内存）
    try {
      const ext = this.context.gl.getExtension("WEBGL_lose_context");
      if (ext) {
        ext.loseContext();
      }
    } catch {
      // 静默忽略
    }
  }
}
