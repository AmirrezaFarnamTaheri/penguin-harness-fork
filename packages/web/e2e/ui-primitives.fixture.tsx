import { useState } from "react";
import { en } from "../src/lib/strings-en";
import { setActiveStrings } from "../src/lib/strings";
// CloseButton reads S.common.close (3f868ac385, #54) and Sheet renders it, so the
// dictionary must be bound before any fixture component that contains a dialog can render.
setActiveStrings(en);
import { createRoot } from "react-dom/client";
import { OptionMenu } from "../src/components/ui/option-menu";
import { Select } from "../src/components/ui/select";
import { Sheet } from "../src/components/ui/sheet";
import { Toaster, toastError, toastSuccess } from "../src/components/ui/toast";

function Fixture() {
  const [selectValue, setSelectValue] = useState("one");
  const [menuValue, setMenuValue] = useState<"alpha" | "beta">("alpha");
  const [sheetOpen, setSheetOpen] = useState(false);

  return (
    <main>
      <Select
        aria-label="Flavor"
        value={selectValue}
        onChange={(event) => setSelectValue(event.target.value)}
      >
        <option value="one">One</option>
        <option value="two" disabled>
          Two
        </option>
        <option value="three">Three</option>
      </Select>

      <OptionMenu
        aria-label="Mode"
        value={menuValue}
        onChange={setMenuValue}
        options={[
          { value: "alpha", triggerLabel: "Alpha", label: "Alpha", description: "First mode" },
          { value: "beta", triggerLabel: "Beta", label: "Beta", description: "Second mode" },
        ]}
      />

      <button type="button" onClick={() => setSheetOpen(true)}>
        Open sheet
      </button>
      <button type="button" onClick={() => toastError("Could not save")}>
        Show error
      </button>
      <button type="button" onClick={() => toastSuccess("Saved")}>
        Show success
      </button>

      <Sheet open={sheetOpen} snap="full" title="Editor" onClose={() => setSheetOpen(false)}>
        <Select
          aria-label="Sheet flavor"
          value={selectValue}
          onChange={(event) => setSelectValue(event.target.value)}
        >
          <option value="one">One</option>
          <option value="three">Three</option>
        </Select>
        <label>
          Name
          <input />
        </label>
        <button type="button">Last sheet action</button>
      </Sheet>
      <Toaster />
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("fixture root is missing");
createRoot(root).render(<Fixture />);
