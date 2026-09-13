import { describe, expect, it } from "vitest";
import { QueryPartitioner } from "../src/agent/query-partitioner.js";

describe("QueryPartitioner", () => {
  it("classifies specialist intent based on keywords", () => {
    const partitioner = new QueryPartitioner();

    expect(partitioner.classifyIntent("Review system architecture and module boundaries")).toBe(
      "software_architect",
    );
    expect(
      partitioner.classifyIntent(
        "Audit authentication endpoint for OAuth token leak vulnerabilities",
      ),
    ).toBe("security_auditor");
    expect(partitioner.classifyIntent("Write comprehensive unit tests with vitest coverage")).toBe(
      "qa_test_engineer",
    );
    expect(partitioner.classifyIntent("Update the user guide and API README")).toBe(
      "technical_writer",
    );
  });

  it("partitions multi-part queries into sub-queries and aggregates answers", () => {
    const partitioner = new QueryPartitioner();
    const complexPrompt = `
1. Audit the authentication service for security vulnerabilities
2. Write unit tests to cover the token refresh edge cases
3. Update the API documentation with the new token specs
`;

    const result = partitioner.partitionQuery(complexPrompt);
    expect(result.subQueries.length).toBe(3);
    expect(result.subQueries[0]?.targetRole).toBe("security_auditor");
    expect(result.subQueries[1]?.targetRole).toBe("qa_test_engineer");
    expect(result.subQueries[2]?.targetRole).toBe("technical_writer");

    const aggregated = partitioner.aggregateResponses(complexPrompt, [
      { subQueryId: "sq_1", role: "security_auditor", response: "No high severity CVEs found." },
      { subQueryId: "sq_2", role: "qa_test_engineer", response: "Added 5 vitest suites." },
      { subQueryId: "sq_3", role: "technical_writer", response: "Updated README.md." },
    ]);

    expect(aggregated).toContain("### Part 1: security_auditor");
    expect(aggregated).toContain("### Part 2: qa_test_engineer");
    expect(aggregated).toContain("### Part 3: technical_writer");
  });
});
