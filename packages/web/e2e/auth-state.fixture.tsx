import { createRoot } from "react-dom/client";
import { AuthProvider, useAuth } from "../src/state/auth";

function StateProbe() {
  const auth = useAuth();
  return (
    <main>
      <output aria-label="Identity">
        {auth.user === undefined ? "pending" : (auth.user?.userId ?? "signed out")}
      </output>
      <button onClick={() => void auth.refresh().catch(() => undefined)}>Refresh identity</button>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <AuthProvider>
    <StateProbe />
  </AuthProvider>,
);
