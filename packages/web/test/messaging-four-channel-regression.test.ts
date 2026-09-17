import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { MessagingChannel } from "@prismshadow/penguin-server/api";
import {
  MessagingBindingBody,
  type MessagingBindingEditorState,
  type MessagingChannelFacts,
} from "../src/features/messaging/messaging-binding-editor";
import { emptyMessagingForm } from "../src/features/messaging/messaging-binding-form";
import { S, setActiveStrings } from "../src/lib/strings";
import { en } from "../src/lib/strings-en";
import { zh } from "../src/lib/strings-zh";

// T32 reconciliation: exercise the shipped editor, not a second configuration page.
// The server allows four saved configs but only one enabled channel per session.
const channels: readonly MessagingChannel[] = ["feishu", "telegram", "qq", "wechat"];
const empty: MessagingChannelFacts = {
  secretConfigured: false,
  secretMasked: null,
  enabled: false,
  status: { state: "disconnected" },
  lastChatKnown: false,
};

function editor(channel: MessagingChannel, saved: boolean): MessagingBindingEditorState {
  const facts = (name: MessagingChannel): MessagingChannelFacts => ({
    ...empty,
    secretConfigured: saved,
    secretMasked: saved ? `${name}-stored-mask` : null,
    enabled: saved && name === "wechat",
    status: { state: saved && name === "wechat" ? "connected" : "disconnected" },
  });
  const noop = async () => {};
  return {
    sessionId: "four-channel-regression",
    form: emptyMessagingForm(channel),
    patchForm: () => {},
    selectChannel: () => {},
    channels: {
      feishu: facts("feishu"),
      telegram: facts("telegram"),
      qq: facts("qq"),
      wechat: facts("wechat"),
    },
    fieldErrors: {},
    dirty: false,
    busy: false,
    toggling: false,
    testing: false,
    sendingTest: false,
    testable: saved,
    toggleBlocked: !saved || channel !== "wechat",
    toggleHint:
      saved && channel !== "wechat"
        ? S.messaging.otherEnabledHint(S.messaging.channelName.wechat)
        : null,
    adoptBinding: () => {},
    save: noop,
    toggleEnabled: noop,
    testConnection: noop,
    sendTestMessage: noop,
  };
}

const render = (state: MessagingBindingEditorState) =>
  renderToStaticMarkup(createElement(MessagingBindingBody, { b: state }));

// Escape through the same renderer so translated punctuation is compared as HTML.
const text = (value: string) => renderToStaticMarkup(value);
afterEach(() => setActiveStrings(zh));

describe.each([
  ["English", en],
  ["Chinese", zh],
] as const)("existing four-channel editor (%s)", (_locale, dictionary) => {
  it.each(channels)("keeps all four channels selectable while viewing %s", (channel) => {
    setActiveStrings(dictionary);
    const html = render(editor(channel, false));
    const selector = html.slice(0, html.indexOf("</div>"));
    for (const name of channels) {
      expect(selector).toContain(text(S.messaging.channelName[name]));
    }
    expect(selector.match(/<button\b/g)).toHaveLength(4);
    const buttons = selector.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
    expect(buttons.every((button) => !button.includes("disabled"))).toBe(true);
    const selected = buttons.filter((button) => button.includes("bg-white font-medium"));
    expect(selected).toHaveLength(1);
    expect(selected[0]).toContain(text(S.messaging.channelName[channel]));
  });

  it.each(channels)(
    "shows only %s's stored credential and its actual runtime status",
    (channel) => {
      setActiveStrings(dictionary);
      const html = render(editor(channel, true));
      expect(html).toContain(`${channel}-stored-mask`);
      for (const other of channels.filter((name) => name !== channel)) {
        expect(html).not.toContain(`${other}-stored-mask`);
      }
      expect(html).toContain(
        text(S.messaging.status[channel === "wechat" ? "connected" : "disconnected"]),
      );
      if (channel !== "wechat") {
        expect(html).toContain(text(S.messaging.otherEnabledHint(S.messaging.channelName.wechat)));
      }
      expect(render(editor(channel, false))).not.toContain("-stored-mask");
    },
  );

  it("offers QQ and WeChat scan setup without pretending WeChat has a typed token field", () => {
    setActiveStrings(dictionary);
    const qq = render(editor("qq", false));
    const wechat = render(editor("wechat", false));
    expect(qq).toContain(text(S.qq.scanStart));
    expect(qq).toContain(text(S.qq.appId));
    expect(wechat).toContain(text(S.wechat.scanStart));
    expect(wechat).not.toContain('type="password"');
    expect(wechat).toContain(text(S.messaging.test));
    expect(wechat).toContain(text(S.messaging.sendTestMessage));
  });
});
