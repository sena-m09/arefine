export class Budget {
  readonly limitUsd: number;
  #spentUsd = 0;

  constructor(limitUsd: number) {
    this.limitUsd = limitUsd;
  }

  get spentUsd(): number {
    return this.#spentUsd;
  }

  get remainingUsd(): number {
    return Math.max(0, this.limitUsd - this.#spentUsd);
  }

  get exhausted(): boolean {
    return this.remainingUsd <= 0;
  }

  charge(usd: number): void {
    this.#spentUsd += usd;
  }
}
