/**
 * TokenOracle: Self-calibrating token estimator using conformal prediction.
 *
 * Replaces hardcoded chars/4 and chars/3 ratios with a data-driven approach.
 * Maintains a sliding window of observations and uses conformal prediction quantiles
 * to provide calibrated estimates with known coverage guarantees.
 */

export interface TokenOracleStats {
  observationCount: number;
  meanRatio: number;
  coverage95Quantile: number;
}

/**
 * TokenOracle: Self-calibrating token estimator.
 *
 * Maintains a sliding window of (charCount, actualTokens) observations and uses
 * them to estimate token counts with conformal prediction-based uncertainty.
 *
 * Cold start (<10 observations) falls back to hardcoded ratios (chars/4 for normal,
 * chars/3 for safe). Warm oracle uses mean observed ratio with conformal quantile
 * for safe estimates.
 */
export class TokenOracle {
  /**
   * Observations: [{ chars, tokens }, ...]
   * Maintains a sliding window capped at 200 entries.
   */
  private observations: Array<{ chars: number; tokens: number }> = [];
  private sortedResiduals: number[] = [];
  private readonly MAX_OBSERVATIONS = 200;

  /**
   * Record an observation of actual character count and token count.
   *
   * Maintains the sliding window (max 200) and updates sorted residuals.
   */
  public observe(charCount: number, actualTokens: number): void {
    if (charCount <= 0 || actualTokens < 0) {
      return; // Ignore invalid observations
    }

    this.observations.push({ chars: charCount, tokens: actualTokens });

    // Trim to max window size
    if (this.observations.length > this.MAX_OBSERVATIONS) {
      this.observations.shift();
    }

    // Recompute sorted residuals
    this.updateSortedResiduals();
  }

  /**
   * Estimate token count using mean observed ratio.
   *
   * Falls back to chars/4 if cold (<10 observations).
   */
  public estimate(charCount: number): number {
    if (this.isCold()) {
      return Math.ceil(charCount / 4);
    }

    const meanRatio = this.computeMeanRatio();
    return Math.ceil(charCount / meanRatio);
  }

  /**
   * Estimate token count with conformal prediction (conservative).
   *
   * Falls back to chars/3 if cold (<10 observations).
   * Otherwise, uses mean ratio + conformal quantile of residuals at given coverage.
   *
   * @param charCount - Character count to estimate
   * @param coverage - Coverage level (default 0.95)
   */
  public estimateSafe(charCount: number, coverage: number = 0.95): number {
    if (this.isCold()) {
      return Math.ceil(charCount / 3);
    }

    const meanRatio = this.computeMeanRatio();
    const baseEstimate = charCount / meanRatio;

    // Get conformal quantile of residuals
    const quantile = this.getConformalQuantile(coverage);

    // Conservative estimate: mean + conformal quantile margin
    return Math.ceil(baseEstimate + quantile);
  }

  /**
   * Check if oracle is in cold-start state (<10 observations).
   */
  public isCold(): boolean {
    return this.observations.length < 10;
  }

  /**
   * Get oracle statistics for debugging/monitoring.
   */
  public getStats(): TokenOracleStats {
    if (this.observations.length === 0) {
      return {
        observationCount: 0,
        meanRatio: 4, // Default fallback
        coverage95Quantile: 0,
      };
    }

    const meanRatio = this.computeMeanRatio();
    const quantile = this.getConformalQuantile(0.95);

    return {
      observationCount: this.observations.length,
      meanRatio,
      coverage95Quantile: quantile,
    };
  }

  /**
   * Compute mean chars-to-tokens ratio from observations.
   * @private
   */
  private computeMeanRatio(): number {
    if (this.observations.length === 0) {
      return 4; // Default fallback
    }

    let sumRatio = 0;
    for (const obs of this.observations) {
      if (obs.tokens > 0) {
        sumRatio += obs.chars / obs.tokens;
      }
    }

    const mean = sumRatio / this.observations.length;
    return mean > 0 ? mean : 4; // Fallback to 4 if mean is invalid
  }

  /**
   * Compute residuals and maintain sorted list.
   * @private
   */
  private updateSortedResiduals(): void {
    const meanRatio = this.computeMeanRatio();
    const residuals: number[] = [];

    for (const obs of this.observations) {
      const predicted = obs.chars / meanRatio;
      const residual = Math.abs(obs.tokens - predicted);
      residuals.push(residual);
    }

    // Sort residuals ascending
    this.sortedResiduals = residuals.sort((a, b) => a - b);
  }

  /**
   * Get conformal prediction quantile for given coverage level.
   *
   * Uses the empirical quantile of residuals at the given level.
   * For n observations and coverage p, returns the residual at position
   * ceiling((n+1)*p) - 1, clamped to [0, n-1].
   *
   * This gives us the residual value such that at least coverage fraction
   * of past prediction errors were at or below it.
   *
   * @param coverage - Coverage level (e.g., 0.95)
   * @private
   */
  private getConformalQuantile(coverage: number): number {
    if (this.sortedResiduals.length === 0) {
      return 0;
    }

    // Conformal prediction quantile: ceiling((n+1)*p) - 1, clamped to valid range
    const n = this.sortedResiduals.length;
    const position = Math.min(Math.ceil((n + 1) * coverage) - 1, n - 1);

    return this.sortedResiduals[position] ?? 0;
  }
}
