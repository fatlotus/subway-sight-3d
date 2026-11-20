export interface FallbackViewOptions {
  onRetry?: () => void;
  doc?: Document;
}

/**
 * Graceful non-crashing recovery banner when WebGL2 is unavailable or webglcontextlost occurs.
 */
export class FallbackView {
  private readonly root: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly messageEl: HTMLElement;
  private readonly retryBtn: HTMLButtonElement;
  private readonly onRetry?: () => void;
  private readonly handleRetryClick: (ev: Event) => void;
  private readonly stopBubble: (ev: Event) => void;

  constructor(container: HTMLElement, options?: FallbackViewOptions) {
    const doc = options?.doc ?? container.ownerDocument ?? document;
    this.onRetry = options?.onRetry;

    this.root = doc.createElement('div');
    this.root.className = 'webgl-fallback-banner';
    this.root.setAttribute('data-testid', 'webgl-fallback-banner');
    this.root.setAttribute('role', 'alert');
    this.root.hidden = true;

    this.titleEl = doc.createElement('h2');
    this.titleEl.className = 'webgl-fallback-title';

    this.messageEl = doc.createElement('p');
    this.messageEl.className = 'webgl-fallback-message';

    this.retryBtn = doc.createElement('button');
    this.retryBtn.type = 'button';
    this.retryBtn.className = 'hud-btn hud-btn--primary hud-btn--compact';
    this.retryBtn.setAttribute('data-testid', 'btn-webgl-retry');
    this.retryBtn.textContent = 'Retry 3D View';

    this.handleRetryClick = (ev: Event) => {
      ev.stopPropagation();
      this.onRetry?.();
    };
    this.stopBubble = (ev: Event) => {
      ev.stopPropagation();
    };

    this.retryBtn.addEventListener('click', this.handleRetryClick);
    this.root.addEventListener('pointerdown', this.stopBubble);
    this.root.addEventListener('touchstart', this.stopBubble);

    this.root.appendChild(this.titleEl);
    this.root.appendChild(this.messageEl);
    this.root.appendChild(this.retryBtn);
    container.appendChild(this.root);
  }

  showUnavailable(detail?: string): void {
    this.titleEl.textContent = '3D View Unavailable';
    this.messageEl.textContent =
      detail ??
      'WebGL graphics could not be initialized on this device. Live telemetry, localization, and nearby train tracking remain active.';
    this.root.setAttribute('data-reason', 'unavailable');
    this.root.hidden = false;
  }

  showContextLost(): void {
    this.titleEl.textContent = '3D Graphics Context Paused';
    this.messageEl.textContent =
      'The WebGL context was interrupted by the browser. Tap Retry to restore the 3D scene while telemetry continues running.';
    this.root.setAttribute('data-reason', 'context-lost');
    this.root.hidden = false;
  }

  hide(): void {
    this.root.hidden = true;
    this.root.removeAttribute('data-reason');
  }

  isVisible(): boolean {
    return !this.root.hidden;
  }

  dispose(): void {
    this.retryBtn.removeEventListener('click', this.handleRetryClick);
    this.root.removeEventListener('pointerdown', this.stopBubble);
    this.root.removeEventListener('touchstart', this.stopBubble);
    if (this.root.parentNode) {
      this.root.parentNode.removeChild(this.root);
    }
  }
}
