export type AgentHarness = 'claude' | 'codex';
export interface PeerIdentity { readonly pluginId: string; readonly displayName?: string }
export interface ThreadArtifactRef { readonly providerId: string; readonly kind: string; readonly schemaVersion: number; readonly id: string; readonly title: string; readonly data: unknown; readonly storageRoot?: string }
export interface ArtifactActionHost { openView(state: { type: string; state?: Record<string, unknown> }): Promise<'context-panel' | 'tab' | 'unavailable'>; revealInFolder(path: string): Promise<boolean>; updateArtifact(patch: { title?: string; data?: unknown }): Promise<void> }
export type ArtifactActionResult = { status: 'ok'; message?: string } | { status: 'warning' | 'error'; message: string };
export interface ArtifactPresentation { title: string; subtitle?: string; icon?: string; actions: readonly { id: string; label: string; tooltip?: string; variant?: 'primary' | 'secondary'; icon?: string; shortLabel?: string }[] }
export interface ArtifactContribution { readonly providerId: string; readonly kinds: readonly string[]; present(ref: ThreadArtifactRef): ArtifactPresentation; invoke(actionId: string, ref: ThreadArtifactRef, host: ArtifactActionHost): Promise<ArtifactActionResult> }
export interface SlashCommandResult { readonly status: 'ok' | 'error'; readonly message?: string }
export interface SlashCommandContext { readonly surface: 'thread' | 'dispatch'; readonly text: string; readonly args: string; readonly threadId?: string; readonly agentHarness?: AgentHarness; readonly projectId?: string; readonly hasImages: boolean; readonly hasAttachment: boolean }
export interface SlashCommandHost { readonly signal: AbortSignal; report(message: string, isError?: boolean): void }
export interface SlashCommandArgCompletion { readonly name: string; readonly description: string }
export interface SlashCommandContribution { readonly name: string; readonly thread?: { description: string; argCompletions?: readonly SlashCommandArgCompletion[]; invoke(context: SlashCommandContext, host: SlashCommandHost): Promise<SlashCommandResult> }; readonly dispatch?: { description: string; argCompletions?: readonly SlashCommandArgCompletion[]; invoke(context: SlashCommandContext, host: SlashCommandHost): Promise<SlashCommandResult> } }
export interface ThreadPermissionSnapshot { readonly effectivePermissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'; readonly planApprovalPending: boolean }
export type StorageAllocationResult = { success: true; path: string; artifactId: string; status: 'allocated' | 'existing' } | { success: false; message: string; artifactId: string; status: string };
/**
 * `visible` asks the host to create a folder named `folderName` under its configured visible root and
 * a namespace it derives from the caller (sanitized and collision-suffixed by the host; the plugin
 * uses whatever path is returned).
 * Visible allocations require `owner`; the host derives the namespace from `owner.pluginId`.
 * Hosts without the capability ignore the options and return the hidden path.
 */
export interface StorageAllocationOptions { readonly location?: 'hidden' | 'visible'; readonly folderName?: string; readonly owner?: Pick<PeerIdentity, 'pluginId'> }
/** Advertised by hosts that honour `StorageAllocationOptions`; optional, never required. */
export const VISIBLE_STORAGE_CAPABILITY = 'artifacts.visibleStorage';
export interface AgentToolHost { permissions(): Promise<ThreadPermissionSnapshot | null>; allocateStorage(id: string): Promise<StorageAllocationResult> }
export interface AgentToolContribution { readonly name: string; readonly description: string; readonly inputSchema: unknown; readonly alwaysLoad?: boolean; readonly requiresApproval?: boolean; invoke(threadId: string, args: Record<string, unknown>, host: AgentToolHost): Promise<{ content: readonly { type: 'text'; text: string }[]; isError?: boolean }> }
/** The subset of `PublicThreadEvent` this plugin reads. */
export interface PublicThreadEvent { readonly kind: string; readonly threadId: string; readonly runId?: string }
export interface ProvisionalThreadHandle { readonly threadId: string; commit(): Promise<unknown>; rollback(): Promise<unknown> }
export interface AgentThreadsApiV1 {
  readonly apiVersion: 1;
  readonly generation: string;
  readonly capabilities: readonly string[];
  readonly threads: {
    get(id: string): Promise<{ id: string; cwd?: string; artifacts?: readonly ThreadArtifactRef[]; /** Present on current Agent Threads builds; absent on older ones. */ isRunning?: boolean } | null>;
    beginProvisional(owner: PeerIdentity, input: { title?: string; agentHarness?: AgentHarness; ownerPluginId?: string }): Promise<ProvisionalThreadHandle>;
    send(id: string, input: { prompt: string; ownerPluginId?: string; idempotencyKey?: string }): Promise<{ runId: string }>;
    open(id: string): Promise<void>;
    /** Optional: advertised by the `threads.subscribe` capability. */
    subscribe?(listener: (event: PublicThreadEvent) => void): { dispose(): void };
    /** Optional: advertised by the `threads.wait` capability. */
    wait?(runId: string, options?: { timeoutMs?: number }): Promise<{ status: 'completed' | 'failed' | 'timed_out'; error?: { code?: string; message?: string } }>;
    permissions(id: string): Promise<ThreadPermissionSnapshot | null>;
  };
  readonly artifacts: {
    list(threadId: string): Promise<readonly ThreadArtifactRef[]>;
    allocateStorage(threadId: string, artifactId: string, options?: StorageAllocationOptions): Promise<StorageAllocationResult>;
    attach(owner: PeerIdentity, threadId: string, ref: ThreadArtifactRef): Promise<{ success: boolean; message?: string }>;
    update(owner: PeerIdentity, threadId: string, artifactId: string, patch: { title?: string; data?: unknown; storageRoot?: string }): Promise<{ success: boolean; message?: string }>;
    invokeAction(threadId: string, artifactId: string, actionId: string): Promise<ArtifactActionResult>;
  };
  readonly extensions: {
    registerArtifactProvider(owner: PeerIdentity, contribution: ArtifactContribution): { success: boolean; message?: string; dispose(): void };
    registerAgentTool(owner: PeerIdentity, contribution: AgentToolContribution): { success: boolean; message?: string; dispose(): void };
    registerSlashCommand(owner: PeerIdentity, contribution: SlashCommandContribution): { success: boolean; message?: string; dispose(): void };
  };
}
export interface AgentThreadsPlugin { api?: { v1?: AgentThreadsApiV1 } }
