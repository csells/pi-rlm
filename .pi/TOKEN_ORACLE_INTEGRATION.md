# TokenOracle Integration Guide

This document describes the exact changes needed to integrate TokenOracle into the codebase once task-2 (GoldOwl) releases externalizer.ts and index.ts.

## Changes to src/context/externalizer.ts

### 1. Add ITokenOracle import (line 11-17)

```typescript
import type {
  ExtensionContext,
  IExternalStore,
  ITokenOracle,  // ADD THIS LINE
  ITrajectoryLogger,
  IWarmTracker,
  RlmConfig,
} from "../types.js";
```

### 2. Add oracle field to ExternalizerState interface (after line 66)

```typescript
export interface ExternalizerState {
  enabled: boolean;
  config: RlmConfig;
  store: IExternalStore;
  manifest: ManifestBuilder;
  warmTracker: IWarmTracker;
  activePhases: Set<string>;
  turnCount: number;
  storeHealthy: boolean;
  allowCompaction: boolean;
  forceExternalizeOnNextTurn: boolean;
  trajectory?: ITrajectoryLogger;
  oracle?: ITokenOracle;  // ADD THIS LINE
  updateWidget?: (ctx: ExtensionContext) => void;
}
```

### 3. Update onContext() to observe oracle (after getting usage, around line 585)

In the `onContext()` function, after `const usage = ctx.getContextUsage?.();`, add:

```typescript
  // Observe actual token usage if oracle is available
  if (state.oracle && usage && usage.tokens !== null && messages.length > 0) {
    // Count actual characters in messages
    let totalChars = 0;
    for (const msg of messages) {
      if (typeof msg.content === "string") {
        totalChars += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text" && block.text) {
            totalChars += block.text.length;
          }
        }
      }
    }
    // Record the observation for calibration
    state.oracle.observe(totalChars, usage.tokens);
  }
```

### 4. Pass oracle to token counting functions (around lines 590-595)

Update these two lines:

```typescript
    // OLD:
    const postStubTokens = countMessageTokens(messages);
    // NEW:
    const postStubTokens = countMessageTokens(messages, state.oracle);

    // ... later in the function ...

    // OLD:
    const postManifestTokens = countMessageTokensSafe(messages);
    // NEW:
    const postManifestTokens = countMessageTokensSafe(messages, state.oracle);
```

## Changes to src/index.ts

### 1. Add TokenOracle import (line 8, after ManifestBuilder import)

```typescript
import { TokenOracle } from "./context/token-oracle.js";
```

### 2. Add oracle field to RlmState interface (after warmTracker field)

```typescript
export interface RlmState extends ExternalizerState {
  config: RlmConfig;
  store: IExternalStore;
  manifest: ManifestBuilder;
  engine: RecursiveEngine;
  callTree: CallTree;
  costEstimator: CostEstimator;
  trajectory: ITrajectoryLogger;
  warmTracker: IWarmTracker;
  oracle: TokenOracle;  // ADD THIS LINE
  activePhases: Set<string>;
  sessionId: string;
  turnCount: number;
  storeHealthy: boolean;
  allowCompaction: boolean;
  forceExternalizeOnNextTurn: boolean;
  updateWidget: (ctx: ExtensionContext) => void;
}
```

### 3. Create oracle in createBootstrapState() (around line 65-75)

```typescript
function createBootstrapState(): RlmState {
  const sessionId = "bootstrap";
  const storeDir = getRlmStoreDir(process.cwd(), sessionId);
  const store = new ExternalStore(storeDir, sessionId);
  const warmTracker = new WarmTracker(DEFAULT_CONFIG.warmTurns);
  const trajectory = new TrajectoryLogger(storeDir);
  const oracle = new TokenOracle();  // ADD THIS LINE
  const callTree = new CallTree(DEFAULT_CONFIG.maxChildCalls);
  const costEstimator = new CostEstimator(store);
  const engine = new RecursiveEngine(
    DEFAULT_CONFIG,
    store,
    trajectory,
    callTree,
    costEstimator,
    warmTracker,
  );

  return {
    enabled: true,
    config: { ...DEFAULT_CONFIG },
    store,
    manifest: new ManifestBuilder(store),
    engine,
    callTree,
    costEstimator,
    trajectory,
    warmTracker,
    oracle,  // ADD THIS LINE
    activePhases: new Set<string>(),
    sessionId,
    turnCount: 0,
    storeHealthy: true,
    allowCompaction: false,
    forceExternalizeOnNextTurn: false,
    updateWidget: (_ctx) => {
      // Widget wiring is added by task-12.
    },
  };
}
```

### 4. Create new oracle in onSessionStart() (around line 200)

After the `state.warmTracker = new WarmTracker(...)` line, add:

```typescript
  // Rebind session-scoped components
  state.store = store;
  state.manifest = new ManifestBuilder(store);
  state.warmTracker = new WarmTracker(state.config.warmTurns);
  state.oracle = new TokenOracle();  // ADD THIS LINE
  state.trajectory = new TrajectoryLogger(storeDir);
  state.callTree = new CallTree(state.config.maxChildCalls);
  state.costEstimator = new CostEstimator(store);
  // ... rest of method
```

## Testing

After integration:
- Run `npm run build` to verify TypeScript compilation
- Run `npm test -- --run tests/unit/` to verify all unit tests pass
- The TokenOracle should be created fresh for each session
- The oracle will observe token counts and self-calibrate over time
- Cold start (<10 observations) will use hardcoded chars/4 and chars/3 ratios
- Warm oracle will use learned mean ratio with conformal prediction quantiles

## Implementation Status

✓ TokenOracle class complete with conformal prediction
✓ 15 unit and integration tests passing
✓ Types defined in src/types.ts
✓ Token counting functions updated in src/context/tokens.ts
⏳ Pending: Integration into externalizer.ts and index.ts (blocked by task-2)
