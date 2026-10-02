import { parseDocument } from "yaml";
const p = (label, fn) => { try { console.log(label, "=>", JSON.stringify(fn())); } catch (e) { console.log(label, "THREW:", e.message.split("\n")[0]); } };

p("empty doc: setIn nested", () => { const d = parseDocument(""); d.setIn(["a", "b"], 1); return d.toString(); });
p("empty doc: createNode({}) root then setIn", () => { const d = parseDocument(""); d.contents = d.createNode({}); d.setIn(["a", "b"], 1); return d.toString(); });
p("empty doc: createNode(new YAMLMap?)", () => { const d = parseDocument(""); d.contents = d.createNode({}); return d.toString(); });
p("comments-only: createNode({}) root then setIn", () => { const d = parseDocument("# keep me\n"); d.contents = d.createNode({}); d.setIn(["a"], 1); return d.toString(); });
p("existing map: setIn new nested path", () => { const d = parseDocument("name: x\n"); d.setIn(["model", "max_tokens"], 1); return d.toString(); });
p("existing null section (tools:) then setIn", () => { const d = parseDocument("tools:\n"); d.setIn(["tools", "a"], 1); return d.toString(); });
p("fresh seq style in 2-space doc", () => { const d = parseDocument("name: x\n"); d.setIn(["tools"], ["a", "b"]); return d.toString(); });
p("fresh seq as node in doc", () => { const d = parseDocument("name: x\n"); d.setIn(["tools"], d.createNode(["a", "b"])); return d.toString(); });
p("scalar quoting: add 'off'", () => { const d = parseDocument("a: 1\n"); d.setIn(["b"], "off"); return d.toString(); });
p("scalar quoting: add number as string", () => { const d = parseDocument("a: 1\n"); d.setIn(["b"], "4096"); return d.toString(); });
p("indentSeq:false fresh seq", () => { const d = parseDocument("tools:\n- a\n"); d.setIn(["more"], ["x"]); return d.toString({ indentSeq: false }); });
p("comment attached to edited key survives", () => { const d = parseDocument("# c1\nname: x # inline\n# c2 after\n"); d.setIn(["name"], "y"); return d.toString(); });
p("block scalar preserved", () => { const d = parseDocument("system_prompt: |\n  line one\n  line two\nother: 1\n"); d.setIn(["other"], 2); return d.toString(); });
p("flow map preserved", () => { const d = parseDocument("model: { max_tokens: 1, name: x }\n"); d.setIn(["other"], 2); return d.toString(); });
p("document with directives", () => { const d = parseDocument("%YAML 1.2\n---\nname: x\n"); return [d.errors.map((e) => e.code).join(","), d.toString(), d.directives ? "has-directives" : "no-directives"]; });
