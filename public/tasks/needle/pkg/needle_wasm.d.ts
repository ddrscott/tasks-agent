/* tslint:disable */
/* eslint-disable */

/**
 * The model and the agents started on it, one per system text and tools
 * (the page switches between them without reading the tools again).
 */
export class Needle {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * One turn: a user message, or a tool result (JSON) after a call.
     * Returns the result envelope as JSON.
     */
    complete(input: string, max_new_tokens: number): string;
    /**
     * A typed decision: the turn must call a tool, and every enum argument
     * it fills comes back with the probability of each option
     * (`decisions` in the envelope).
     */
    decide(input: string, max_new_tokens: number): string;
    /**
     * Switch to the agent for `key`, starting it on the system text and
     * tools (a JSON list of OpenAI-style function schemas) the first time.
     * Returns the prompt prefix length in tokens, or 0 when the agent
     * already existed.
     */
    init(key: string, system: string, tools_json: string): number;
    /**
     * Load a `.cact` archive (its bytes; the archive is dropped once the
     * weights are repacked).
     */
    constructor(cact: Uint8Array);
    /**
     * Forget the current agent's conversation, keeping its tools.
     */
    reset(): void;
}

/**
 * Whether this build's arithmetic is exact in this browser: always for the
 * exact build; for the relaxed build, whether the browser fuses
 * `relaxed_madd` (it may not, on a CPU without FMA).
 */
export function maddFused(): boolean;

/**
 * Which arithmetic this build uses: `"relaxed"` (the hardware's fused
 * multiply-add, when [`madd_fused`] holds) or `"exact"` (fused multiply-add
 * computed exactly in software).
 */
export function simdMode(): string;

/**
 * Check the SIMD arithmetic against its scalar definition (a report).
 */
export function simdSelftest(n: number): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_needle_free: (a: number, b: number) => void;
    readonly maddFused: () => number;
    readonly needle_complete: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly needle_decide: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly needle_init: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly needle_new: (a: number, b: number) => [number, number, number];
    readonly needle_reset: (a: number) => [number, number];
    readonly simdMode: () => [number, number];
    readonly simdSelftest: (a: number) => [number, number];
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
