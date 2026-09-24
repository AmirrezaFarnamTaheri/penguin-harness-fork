import { S } from "../lib/strings";
import { Section } from "../components/section";

/** Public results stay unpublished until the benchmark can be independently reproduced. */
export function Benchmark() {
  return (
    <Section
      id="benchmark"
      eyebrow={S.benchmark.eyebrow}
      title={S.benchmark.title}
      subtitle={S.benchmark.subtitle}
    >
      <div
        role="status"
        className="mx-auto max-w-3xl rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm leading-6 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100"
      >
        {S.benchmark.provisionalNote}
      </div>
    </Section>
  );
}
