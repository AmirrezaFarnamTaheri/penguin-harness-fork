import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { ProductNavigation } from "../src/components/layout/product-navigation";
import { NAV_ICONS } from "../src/components/ui/icons";
import { navKeysFor, navPathFor } from "../src/lib/nav-group-collapse";
import { S, setActiveStrings } from "../src/lib/strings";
import { en } from "../src/lib/strings-en";
import { zh } from "../src/lib/strings-zh";

setActiveStrings(en);
function Fixture() {
  const [locale, setLocale] = useState("en");
  const [visits, setVisits] = useState(0);
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <>
      <aside className="flex h-screen w-64 flex-col bg-gray-50 p-2 dark:bg-gray-900">
        <ProductNavigation
          key={locale}
          items={navKeysFor(false).map((key) => ({
            key,
            to: navPathFor(key),
            label: S.nav[key],
            icon: NAV_ICONS[key],
            note: key === "skills" ? "Update available" : null,
          }))}
          onNavigate={() => setVisits((n) => n + 1)}
        />
        <p>Conversations</p>
        <a href="#conversation">Example conversation</a>
      </aside>
      <button onClick={() => navigate("/models/keys")}>Open API keys directly</button>
      <button
        onClick={() => {
          setActiveStrings(zh);
          setLocale("zh");
        }}
      >
        Chinese
      </button>
      <output aria-label="Current route">{location.pathname}</output>
      <output aria-label="Navigation callbacks">{visits}</output>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <MemoryRouter initialEntries={["/cockpit"]}>
    <Fixture />
  </MemoryRouter>,
);
