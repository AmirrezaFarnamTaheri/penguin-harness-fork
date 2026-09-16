/**
 * Vitest global test setup for @prismshadow/penguin-web.
 * Initializes active dictionary S to Chinese strings so pure unit tests
 * evaluating components or helpers outside the browser main.tsx boot flow
 * have access to synchronous string bindings.
 */
import { setActiveStrings } from "../src/lib/strings";
import { zh } from "../src/lib/strings-zh";

setActiveStrings(zh);
