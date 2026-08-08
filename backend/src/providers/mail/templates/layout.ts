/**
 * The shared HTML shell for every Lumora email.
 *
 * Email HTML is not web HTML, and almost every modern technique is unavailable:
 *
 * - **Tables for layout, not divs.** Outlook renders through Word's engine,
 *   which has no float, no flex, and no grid. `role="presentation"` keeps the
 *   tables out of the accessibility tree so a screen reader reads prose rather
 *   than announcing a five-by-one grid.
 * - **Inline styles.** Gmail strips `<style>` blocks in several contexts —
 *   forwarded mail, the Android app, clipped messages. Anything that must
 *   survive is inlined; the `<style>` block carries only progressive
 *   enhancement (dark mode, the small-screen breakpoint) that is safe to lose.
 * - **No web fonts.** They are blocked nearly everywhere. Georgia is the
 *   fallback the design system already names for Source Serif 4
 *   (docs/01-design-system.md §2.2), so the brand's serif identity survives
 *   without a single request.
 * - **No remote images.** Clients block them by default, so an image-dependent
 *   layout arrives broken for most recipients on first open. There are none
 *   here; the wordmark is text.
 *
 * Dark mode is best-effort by nature: `prefers-color-scheme` is honoured by
 * Apple Mail and iOS and ignored by Gmail's web client. The light palette is
 * therefore the one that has to be correct on its own, with dark as an
 * enhancement — never the reverse.
 */

/** Lumora's palette, mirrored from docs/01-design-system.md §2.1. */
const COLORS = {
  canvas: '#f7f7f9',
  surface: '#ffffff',
  ink: '#141418',
  body: '#55555f',
  muted: '#6e6e7c',
  line: '#e8e8ed',
  accent: '#4f46e5',
  onInk: '#ffffff',
  darkCanvas: '#09090b',
  darkSurface: '#141418',
  darkInk: '#f7f7f9',
  darkBody: '#9d9daa',
  darkMuted: '#848492',
  darkLine: '#27272e',
} as const;

/**
 * Escapes a value before it is interpolated into HTML.
 *
 * `displayName` is user-supplied and lands in a message body we send from our
 * own domain. Without escaping, a name of `<img src=x onerror=…>` is stored
 * XSS that we deliver to the user's inbox ourselves — and mail clients that
 * render HTML are a genuine execution surface.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface EmailLayout {
  /** Sets the `<title>`, read by some clients as the message name. */
  title: string;
  /**
   * The inbox preview line, shown next to the subject before the message is
   * opened. Without one, clients scrape the first visible text — which here
   * would be the word "Lumora" for every email we send.
   */
  preheader: string;
  heading: string;
  /** Body paragraphs. Already-escaped HTML. */
  paragraphs: string[];
  action: { label: string; url: string };
  /** Shown under the button, above the fallback URL. */
  footnote?: string;
}

/**
 * A button that survives Outlook.
 *
 * Built as a single-cell table with padding on the cell rather than on the
 * anchor: Word's rendering engine ignores padding on inline elements, so a
 * styled `<a>` collapses to bare underlined text there. The anchor still fills
 * the cell so the whole area is clickable everywhere else.
 */
function button(label: string, url: string): string {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
      <tr>
        <td align="center" bgcolor="${COLORS.ink}" class="lm-btn" style="border-radius:6px;">
          <a href="${url}"
             class="lm-btn-a"
             style="display:inline-block;padding:12px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:20px;font-weight:600;color:${COLORS.onInk};text-decoration:none;border-radius:6px;">${escapeHtml(label)}</a>
        </td>
      </tr>
    </table>`;
}

export function renderLayout(layout: EmailLayout): string {
  const paragraphs = layout.paragraphs
    .map(
      (text) =>
        `<p class="lm-body" style="margin:0 0 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:24px;color:${COLORS.body};">${text}</p>`,
    )
    .join('\n          ');

  return `<!doctype html>
<html lang="en" style="color-scheme:light dark;supported-color-schemes:light dark;">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta http-equiv="x-ua-compatible" content="ie=edge" />
    <meta name="color-scheme" content="light dark" />
    <meta name="supported-color-schemes" content="light dark" />
    <title>${escapeHtml(layout.title)}</title>
    <style>
      /* Progressive enhancement only — everything essential is inlined. */
      @media only screen and (max-width: 480px) {
        .lm-shell { padding: 20px 12px !important; }
        .lm-card { padding: 24px 20px !important; }
        .lm-h1 { font-size: 22px !important; line-height: 30px !important; }
      }
      @media (prefers-color-scheme: dark) {
        .lm-bg { background: ${COLORS.darkCanvas} !important; }
        .lm-card { background: ${COLORS.darkSurface} !important; border-color: ${COLORS.darkLine} !important; }
        .lm-h1, .lm-brand { color: ${COLORS.darkInk} !important; }
        .lm-body { color: ${COLORS.darkBody} !important; }
        .lm-muted, .lm-foot { color: ${COLORS.darkMuted} !important; }
        .lm-url { color: ${COLORS.darkBody} !important; }
        /* The button inverts: near-white on near-black reads as the primary
           action in dark exactly as near-black on white does in light. */
        .lm-btn { background: ${COLORS.darkInk} !important; }
        .lm-btn-a { color: ${COLORS.darkCanvas} !important; }
        .lm-rule { border-color: ${COLORS.darkLine} !important; }
      }
    </style>
  </head>
  <body class="lm-bg" style="margin:0;padding:0;width:100%;background:${COLORS.canvas};-webkit-font-smoothing:antialiased;">
    <!-- Preheader. Hidden in the body, shown in the inbox list. The trailing
         entities stop clients padding the preview with the message's markup. -->
    <div style="display:none;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${COLORS.canvas};">
      ${escapeHtml(layout.preheader)}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;
    </div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="lm-bg" style="background:${COLORS.canvas};">
      <tr>
        <td align="center" class="lm-shell" style="padding:40px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;margin:0 auto;">

            <tr>
              <td style="padding:0 0 20px;">
                <span class="lm-brand" style="font-family:Georgia,'Times New Roman',serif;font-size:19px;line-height:24px;font-weight:600;letter-spacing:-0.01em;color:${COLORS.ink};">Lumora</span>
              </td>
            </tr>

            <tr>
              <td class="lm-card" style="background:${COLORS.surface};border:1px solid ${COLORS.line};border-radius:8px;padding:32px;">
                <h1 class="lm-h1" style="margin:0 0 12px;font-family:Georgia,'Times New Roman',serif;font-size:24px;line-height:32px;font-weight:600;letter-spacing:-0.01em;color:${COLORS.ink};">${escapeHtml(layout.heading)}</h1>

                ${paragraphs}

                <div style="padding:8px 0 4px;">
                  ${button(layout.action.label, layout.action.url)}
                </div>

                ${
                  layout.footnote
                    ? `<p class="lm-muted" style="margin:16px 0 0;text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:20px;color:${COLORS.muted};">${layout.footnote}</p>`
                    : ''
                }

                <hr class="lm-rule" style="margin:24px 0 16px;border:none;border-top:1px solid ${COLORS.line};" />

                <p class="lm-muted" style="margin:0 0 6px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:20px;color:${COLORS.muted};">
                  If the button does not work, copy this link into your browser:
                </p>
                <!-- Anchored, not bare text: many clients autolink URLs badly,
                     truncating at the first hyphen in a base64url token. -->
                <p class="lm-url" style="margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;word-break:break-all;color:${COLORS.body};">
                  <a href="${layout.action.url}" style="color:inherit;text-decoration:underline;">${layout.action.url}</a>
                </p>
              </td>
            </tr>

            <tr>
              <td align="center" style="padding:20px 8px 0;">
                <p class="lm-foot" style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:${COLORS.muted};">
                  Lumora — grounded answers from your own documents.
                </p>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
