/**
 * Mock implementations of Pi framework types for testing.
 * Provides mocked ExtensionContext, ITrajectoryLogger, and IWarmTracker.
 */

import { vi } from "vitest";
import {
  ExtensionContext,
  ITrajectoryLogger,
  IWarmTracker,
} from "../../src/types.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { ManifestBuilder } from "../../src/context/manifest.js";
import { WarmTracker } from "../../src/context/warm-tracker.js";
import { ExternalizerState } from "../../src/context/externalizer.js";
import { MockStore } from "./mock-store.js";

/**
 * Create a mock ExtensionContext for testing.
 */
export function createMockContext(): ExtensionContext {
  return {
    extensionUri: {
      fsPath: "/mock/extension",
    },
    storageUri: {
      fsPath: "/mock/storage",
    },
    globalStorageUri: {
      fsPath: "/mock/global-storage",
    },
    logUri: {
      fsPath: "/mock/logs",
    },
    workspaceState: {
      get: vi.fn(),
      update: vi.fn(),
      keys: vi.fn(() => []),
    },
    globalState: {
      get: vi.fn(),
      update: vi.fn(),
      keys: vi.fn(() => []),
      setKeysForSync: vi.fn(),
    },
    secrets: {
      get: vi.fn(),
      store: vi.fn(),
      delete: vi.fn(),
      onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    },
    environmentVariableCollection: {
      get: vi.fn(),
      replace: vi.fn(),
      append: vi.fn(),
      prepend: vi.fn(),
      clear: vi.fn(),
      forEach: vi.fn(),
      getScoped: vi.fn(),
      delete: vi.fn(),
    } as any,
    subscriptions: [],
    extension: {
      id: "test-extension",
      extensionPath: "/mock/extension",
      isActive: true,
      packageJSON: {},
      extensionKind: 2,
      exports: undefined,
      activate: vi.fn(),
    } as any,
  } as any;
}

/**
 * Create a mock ITrajectoryLogger for testing.
 */
export function createMockTrajectory(): ITrajectoryLogger {
  return {
    append: vi.fn(),
    flush: vi.fn(async () => {}),
  };
}

/**
 * Create a mock IWarmTracker for testing.
 */
export function createMockWarmTracker(): IWarmTracker {
  return new WarmTracker(3);
}

/**
 * Create an ExternalizerState for testing with sensible defaults.
 */
export function createExternalizerState(store?: MockStore): ExternalizerState {
  const mockStore = store || new MockStore();
  return {
    enabled: true,
    config: {
      ...DEFAULT_CONFIG,
      tokenBudgetPercent: 60,
      safetyValvePercent: 90,
      manifestBudget: 400,
    },
    store: mockStore,
    manifest: new ManifestBuilder(mockStore),
    warmTracker: new WarmTracker(3),
    activePhases: new Set<string>(),
    turnCount: 0,
    storeHealthy: true,
    allowCompaction: false,
    forceExternalizeOnNextTurn: false,
    trajectory: {
      append: vi.fn(),
      flush: async () => {},
    },
    updateWidget: vi.fn(),
  };
}
