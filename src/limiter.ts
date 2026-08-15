interface AttemptBucket {
  readonly attempts: number[]
  blockedUntil: number
}

/** Bounded in-memory sliding-window login limiter with a fixed block period. */
export class LoginLimiter {
  private readonly buckets = new Map<string, AttemptBucket>()

  constructor(
    private readonly windowMs: number,
    private readonly maxAttempts: number,
    private readonly blockMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** Consume one authentication attempt and return retry seconds when denied. */
  consume(key: string, now: number): number | undefined {
    this.prune(now)
    let bucket = this.buckets.get(key)
    if (bucket === undefined) {
      if (this.buckets.size >= this.maxKeys) return Math.ceil(this.windowMs / 1000)
      bucket = { attempts: [], blockedUntil: 0 }
      this.buckets.set(key, bucket)
    }
    if (bucket.blockedUntil > now) return Math.max(1, Math.ceil((bucket.blockedUntil - now) / 1000))
    const cutoff = now - this.windowMs
    while ((bucket.attempts[0] ?? Number.POSITIVE_INFINITY) <= cutoff) bucket.attempts.shift()
    if (bucket.attempts.length >= this.maxAttempts) {
      bucket.blockedUntil = now + this.blockMs
      return Math.max(1, Math.ceil(this.blockMs / 1000))
    }
    bucket.attempts.push(now)
    return undefined
  }

  /** Forget one key after a successful login. */
  reset(key: string): void {
    this.buckets.delete(key)
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs
    for (const [key, bucket] of this.buckets) {
      const last = bucket.attempts.at(-1) ?? 0
      if (bucket.blockedUntil <= now && last <= cutoff) this.buckets.delete(key)
    }
  }
}
