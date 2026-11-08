import {
    Api,
    Context,
    type InlineKeyboardButton,
    type Update,
    type UserFromGetMe,
} from "../src/deps.deno.ts";
import { ConversationMenuPool, ConversationMenuRange } from "../src/menu.ts";
import {
    assertEquals,
    assertFalse,
    assertThrows,
    describe,
    it,
    stub,
} from "./deps.test.ts";

const chat = { id: 42, type: "private" as const, first_name: "A" };

function mkctx(update: Partial<Update> = {}) {
    const ctx = new Context(
        { update_id: 0, ...update } as Update,
        new Api("dummy"),
        {} as UserFromGetMe,
    );
    const calls: { method: string; payload: Record<string, unknown> }[] = [];
    // Installed first, so it runs last and sees the rendered menus
    ctx.api.config.use((_prev, method, payload) => {
        calls.push({ method, payload: payload as Record<string, unknown> });
        // deno-lint-ignore no-explicit-any
        return Promise.resolve({ ok: true, result: true } as any);
    });
    return { ctx, calls };
}

async function render(
    build: (pool: ConversationMenuPool<Context>) => unknown,
) {
    const pool = new ConversationMenuPool<Context>();
    const menu = build(pool);
    const { ctx, calls } = mkctx();
    pool.install(ctx);
    // deno-lint-ignore no-explicit-any
    await ctx.api.sendMessage(chat.id, "menu", { reply_markup: menu as any });
    const markup = calls[0].payload.reply_markup as {
        inline_keyboard: InlineKeyboardButton[][];
    };
    return markup.inline_keyboard;
}

function strip(keyboard: InlineKeyboardButton[][]) {
    return keyboard.map((row) =>
        row.map((btn) => {
            const { callback_data: _, ...rest } = btn as {
                callback_data?: string;
            };
            return rest;
        })
    );
}

describe("ConversationMenuRange", () => {
    it("should support all styling methods of the menu plugin", async () => {
        const keyboard = await render((pool) =>
            pool.create("menu")
                .text("A").style("primary")
                .text("C").danger()
                .text("D").success().row()
                .text("E").primary()
                .text("F").icon("123")
                .disabled("G")
        );
        assertEquals(strip(keyboard), [
            [
                { text: "A", style: "primary" },
                { text: "C", style: "danger" },
                { text: "D", style: "success" },
            ],
            [
                { text: "E", style: "primary" },
                { text: "F", icon_custom_emoji_id: "123" },
                { text: "G", disabled: {} },
            ],
        ]);
    });
    it("should support styling options on all button types", async () => {
        const keyboard = await render((pool) =>
            pool.create("menu")
                .url({ text: "url", style: "danger" }, "https://grammy.dev")
                .webApp({ text: "app", icon_custom_emoji_id: "1" }, "https://a")
                .login({ text: "login", style: "success" }, "https://b")
                .disabled({ text: "off", style: "primary" }).row()
                .switchInline({ text: "si", style: "danger" })
                .switchInlineCurrent({ text: "sic", style: "danger" })
                .switchInlineChosen({ text: "sich", style: "danger" })
                .copyText({ text: "copy", style: "danger" }, "x").row()
                .game({ text: "game", style: "danger" })
                .pay({ text: "pay", style: "danger" })
                .text({ text: "t", payload: "p", style: "primary" })
        );
        assertEquals(strip(keyboard), [
            [
                { text: "url", style: "danger", url: "https://grammy.dev" },
                {
                    text: "app",
                    icon_custom_emoji_id: "1",
                    web_app: { url: "https://a" },
                },
                {
                    text: "login",
                    style: "success",
                    login_url: { url: "https://b" },
                },
                { text: "off", style: "primary", disabled: {} },
            ],
            [
                { text: "si", style: "danger", switch_inline_query: "" },
                {
                    text: "sic",
                    style: "danger",
                    switch_inline_query_current_chat: "",
                },
                {
                    text: "sich",
                    style: "danger",
                    switch_inline_query_chosen_chat: {},
                },
                { text: "copy", style: "danger", copy_text: { text: "x" } },
            ],
            [
                { text: "game", style: "danger", callback_game: {} },
                { text: "pay", style: "danger", pay: true },
                { text: "t", style: "primary" },
            ],
        ]);
        const cb = keyboard[2][2] as InlineKeyboardButton.CallbackButton;
        assertEquals(cb.callback_data.split("/").slice(0, 4), [
            "menu",
            "2",
            "2",
            "p",
        ]);
    });
    it("should resolve dynamic styles, icons, texts, and urls", async () => {
        const keyboard = await render((pool) =>
            pool.create()
                .text(() => "a").style(() => "danger").icon(() => "7")
                .url(() => "b", () => "https://c").primary()
        );
        assertEquals(strip(keyboard), [[
            { text: "a", style: "danger", icon_custom_emoji_id: "7" },
            { text: "b", url: "https://c", style: "primary" },
        ]]);
    });
    it("should style the last static button", async () => {
        const keyboard = await render((pool) =>
            pool.create()
                .text("a").row()
                .dynamic((_ctx, range) => range.text("dyn"))
                .append(new ConversationMenuRange<Context>())
                .danger()
        );
        assertEquals(strip(keyboard), [[{ text: "a", style: "danger" }], [{
            text: "dyn",
        }]]);
    });
    it("should throw when styling without a button", () => {
        const pool = new ConversationMenuPool<Context>();
        assertThrows(() => pool.create().danger());
        assertThrows(() => pool.create().row().icon("1"));
        assertThrows(() =>
            pool.create().dynamic((_ctx, range) => range.text("a")).primary()
        );
    });
});

describe("ConversationMenuPool", () => {
    async function click(style: "danger" | "primary") {
        const pool = new ConversationMenuPool<Context>();
        let clicked = false;
        pool.create("m").text("x", () => {
            clicked = true;
        }).danger();
        const keyboard = await render((p) =>
            p.create("m").text("x").style(style)
        );
        const btn = keyboard[0][0] as InlineKeyboardButton.CallbackButton;
        const { ctx, calls } = mkctx({
            callback_query: {
                id: "0",
                chat_instance: "0",
                from: chat as never,
                data: btn.callback_data,
                message: {
                    message_id: 1,
                    date: 0,
                    chat,
                } as never,
            },
        });
        const { handleClicks } = pool.install(ctx);
        await handleClicks();
        return { clicked, calls };
    }
    it("should handle clicks on styled buttons", async () => {
        const { clicked } = await click("danger");
        assertEquals(clicked, true);
    });
    it("should detect outdated menus when the style changes", async () => {
        using _ = stub(console, "error");
        const { clicked, calls } = await click("primary");
        assertFalse(clicked);
        assertEquals(calls.map((c) => c.method).sort(), [
            "answerCallbackQuery",
            "editMessageReplyMarkup",
        ]);
    });
});
