export type Fingerprint = { hash: string; terms: string[]; signals: string[]; paths?: string[] };

export interface Recipe {
  /** Exact usable input, with presentation-only fields stripped. */
  input: string;
  key: string;
  /** Semantically comparable operation, including its target where known. */
  task: string;
  shape: 'shell' | 'arguments';
}

export interface FailedAttempt {
  recipe: Recipe;
  fingerprint: Fingerprint;
  model_id: string;
}

export type Rationale =
  | { kind: 'input_diff'; from: string; to: string }
  | { kind: 'verified_retry'; text: string; paths?: string[] };

export interface Entry {
  id: string;
  context: {
    project: string;
    directory: string;
    tool: string;
    task: string;
    model_id: string;
  };
  failed_attempts: FailedAttempt[];
  verified_fix: { recipe: Recipe; model_id: string };
  rationale: Rationale;
  scope: 'project' | 'model_scoped';
  state: 'active' | 'stale' | 'archived';
  pinned: boolean;
  verifiedEpisodes: number;
  confidence: number;
  consecutiveMisses: number;
  modelEvidence: { model_id: string; keys: string[] }[];
  createdAt: number;
  verifiedAt: number;
  lastHitAt: number | null;
  supersedes?: string;
}

export interface Ledger {
  version: 1;
  entries: Entry[];
}

export interface ToolCall {
  session: string;
  turn: number;
  step: number;
  model: string;
  project: string;
  directory: string;
  tool: string;
  recipe: Recipe;
  /** Absolute tool working directory used only for diagnostic normalization. */
  cwd?: string;
}

export type Outcome =
  | { kind: 'failure'; diagnostic: string; code: string }
  | { kind: 'success' };

export interface Hint {
  id: string;
  mode: 'pre' | 'post';
  text: string;
}
