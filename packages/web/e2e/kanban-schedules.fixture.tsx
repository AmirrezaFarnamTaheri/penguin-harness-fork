import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { KanbanPage } from "../src/features/kanban/kanban-page";
import { LocaleProvider } from "../src/state/locale";
import { AuthProvider } from "../src/state/auth";
import { ProjectProvider } from "../src/state/project";
import { loadStrings, setActiveStrings } from "../src/lib/strings";

void loadStrings("en").then((strings) => {
  setActiveStrings(strings);
  createRoot(document.getElementById("root")!).render(
    <MemoryRouter>
      <LocaleProvider>
        <AuthProvider>
          <ProjectProvider>
            <KanbanPage />
          </ProjectProvider>
        </AuthProvider>
      </LocaleProvider>
    </MemoryRouter>,
  );
});
