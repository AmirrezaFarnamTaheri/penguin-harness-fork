import { createRoot } from "react-dom/client";
import { PipelineWorkspace } from "../src/features/pipelines/pipelines-page";
import { LocaleProvider } from "../src/state/locale";
import { en } from "../src/lib/strings-en";
import { setActiveStrings } from "../src/lib/strings";
setActiveStrings(en);
createRoot(document.getElementById("root")!).render(
  <LocaleProvider>
    <PipelineWorkspace projectId="studio-test" />
  </LocaleProvider>,
);
