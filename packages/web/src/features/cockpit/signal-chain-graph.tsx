/**
 * Causal provenance chain (T19): a read-only, ordered rendering of one audit chain — root
 * source through executed action. The chain data is the server's audit graph view; this
 * component invents no causality and edits nothing.
 *
 * Node hashes are the AuditRecorder's `eventHash` (the sha256 of the original event), shown
 * truncated so a chain can be correlated with the signed events.jsonl log without printing
 * the full digest into the UI.
 */
export interface SignalChainNode {
  id: string;
  type: string;
  label: string;
  /** Audit event hash, when the node came from the signed audit log; rendered truncated. */
  eventHash?: string;
}

export interface SignalChain {
  chainId: string;
  nodes: SignalChainNode[];
}

export function SignalChainGraph({ chain }: { chain: SignalChain }) {
  return (
    <section aria-label="Causal provenance chain" className="min-w-0 space-y-3">
      <h3 className="text-base font-semibold">Causal provenance chain</h3>
      {chain.nodes.length === 0 ? (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          No recorded chain for this action yet.
        </p>
      ) : (
        <ol className="flex flex-wrap items-center gap-2">
          {chain.nodes.map((node, index) => (
            <li key={node.id} className="flex items-center gap-2">
              {index > 0 && (
                <span aria-hidden="true" className="text-gray-400">
                  →
                </span>
              )}
              <span className="min-w-0 rounded-md border border-gray-200 px-3 py-2 dark:border-gray-800">
                <span className="block font-mono text-[10px] uppercase text-gray-500 dark:text-gray-400">
                  {node.type}
                </span>
                <span className="block break-words text-sm">{node.label}</span>
                {node.eventHash && (
                  <span className="mt-1 block break-all font-mono text-[10px] text-gray-500 dark:text-gray-400">
                    event {node.eventHash.slice(0, 8)}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
