// Serialize this function into page.evaluate; it imports nothing and makes no
// requests. All temporary root attributes and QA nodes are restored in finally.
export async function collectV15ColorMatrix({ surface = "desktop" } = {}) {
  if (!["desktop", "web"].includes(surface)) throw new Error("Expected desktop or web");
  const root = document.documentElement;
  const saved = Object.fromEntries(
    ["class", "data-theme", "data-accent", "data-accent-theme"].map((name) => [
      name,
      root.getAttribute(name),
    ]),
  );
  const accents =
    surface === "desktop"
      ? ["vtron", "minimal-neutral", "claude", "sakura", "ocean-breeze"]
      : ["blue", "violet", "green"];
  const fixture = document.createElement("div");
  fixture.setAttribute("data-v15-qa-matrix", "");
  fixture.setAttribute("aria-hidden", "true");
  fixture.inert = true;
  fixture.style.cssText =
    "position:fixed;left:-30000px;top:0;width:500px;pointer-events:none;z-index:-2147483647;";
  const resolver = document.createElement("span");
  resolver.style.cssText = "transition:none!important;animation:none!important;";
  fixture.append(resolver);
  document.body.append(fixture);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
  const precision = new Set();
  const missingClasses = new Set();
  const samples = [];
  const failures = [];
  const integrations = [];
  const clamp = (value) => Math.min(1, Math.max(0, value));
  const number = (value) => (value.endsWith("%") ? Number.parseFloat(value) / 100 : Number(value));
  function parseDirect(value) {
    let match = /^rgba?\((.*)\)$/i.exec(value);
    if (match) {
      const pieces = match[1].replaceAll(",", " ").replaceAll("/", " ").trim().split(/\s+/);
      return [
        ...pieces
          .slice(0, 3)
          .map((piece) => (piece.endsWith("%") ? number(piece) : Number(piece) / 255)),
        pieces[3] ? number(pieces[3]) : 1,
      ];
    }
    match = /^color\(srgb\s+(.+)\)$/i.exec(value);
    if (match) {
      const pieces = match[1].replaceAll("/", " ").trim().split(/\s+/);
      return [...pieces.slice(0, 3).map(number), pieces[3] ? number(pieces[3]) : 1];
    }
    return null;
  }
  function rgba(value) {
    let parsed = parseDirect(value);
    let method = "computed-srgb-float";
    if (!parsed && CSS.supports("color", `color(from ${value} srgb r g b / alpha)`)) {
      resolver.style.color = `color(from ${value} srgb r g b / alpha)`;
      parsed = parseDirect(getComputedStyle(resolver).color);
      method = "browser-relative-srgb-float";
    }
    if (
      parsed &&
      parsed.every(Number.isFinite) &&
      parsed.slice(0, 3).every((component) => component >= 0 && component <= 1)
    ) {
      precision.add(method);
      return parsed;
    }
    // Ask Chromium to render colors outside sRGB (or unsupported serialized
    // formats). Float16 avoids the old 8-bit rounding near the 4.5 threshold.
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    try {
      const image = context.getImageData(0, 0, 1, 1, {
        colorSpace: "srgb",
        pixelFormat: "rgba-float16",
      });
      if (image.data.BYTES_PER_ELEMENT === 2) {
        precision.add("chromium-canvas-float16");
        return Array.from(image.data).map(clamp);
      }
    } catch {}
    precision.add("chromium-canvas-8bit-fallback");
    return Array.from(context.getImageData(0, 0, 1, 1).data).map((component) => component / 255);
  }
  const over = (top, bottom) => {
    const alpha = top[3] + bottom[3] * (1 - top[3]);
    return [
      ...[0, 1, 2].map((index) =>
        alpha ? (top[index] * top[3] + bottom[index] * bottom[3] * (1 - top[3])) / alpha : 0,
      ),
      alpha,
    ];
  };
  const luminance = (color) =>
    color
      .slice(0, 3)
      .reduce(
        (sum, component, index) =>
          sum +
          [0.2126, 0.7152, 0.0722][index] *
            (component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4),
        0,
      );
  function contrast(foreground, background) {
    const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    return (values[0] + 0.05) / (values[1] + 0.05);
  }
  const rounded = (color) => color.map((component) => Number(component.toFixed(9)));
  const tokenColor = (token) => {
    resolver.style.color = `var(${token})`;
    return rgba(getComputedStyle(resolver).color);
  };
  const same = (left, right) =>
    left.every((component, index) => Math.abs(component - right[index]) < 0.000001);
  const node = (className, parent, tag = "span") => {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = "QA sample";
    element.style.cssText = "transition:none!important;animation:none!important;";
    parent.append(element);
    return element;
  };
  // These variant strings were checked against the actual Button sources in
  // both apps. Hover rows below resolve their exact tokens, not forced :hover.
  const primaryClasses = "bg-primary text-primary-foreground hover:bg-[var(--primary-hover)]";
  const dangerClasses =
    surface === "desktop"
      ? "bg-[var(--destructive-soft)] text-destructive-text hover:bg-[var(--destructive-soft-hover)]"
      : "bg-[var(--destructive-control-bg)] text-[var(--destructive-control-foreground)] hover:bg-[var(--destructive-control-hover)]";
  const dangerHover =
    surface === "desktop" ? "--destructive-soft-hover" : "--destructive-control-hover";
  const backgrounds = [
    ["background", "bg-background", "--background"],
    ["card", "bg-card", "--card"],
    ["muted", "bg-muted", "--muted"],
    ["sidebar", "bg-sidebar", "--sidebar"],
    ["popover", "bg-popover", surface === "web" ? "--background" : "--popover"],
  ];
  const states = [];
  try {
    for (const accent of accents)
      for (const mode of ["light", "dark"]) {
        if (surface === "desktop") {
          root.setAttribute("data-accent-theme", accent);
          root.setAttribute("data-theme", mode);
        } else {
          root.classList.toggle("dark", mode === "dark");
          root.setAttribute("data-accent", accent);
        }
        // getComputedStyle resolves the palette synchronously. An unfocused
        // QA window can suspend rAF, so this measurement does not wait for paint.
        await Promise.resolve();
        const theme = `${accent}/${mode}`;
        const variables = Object.fromEntries(
          [
            "--primary",
            "--primary-text",
            "--muted-foreground",
            "--destructive",
            "--destructive-text",
            "--primary-hover",
            dangerHover,
          ].map((token) => [token, getComputedStyle(root).getPropertyValue(token).trim()]),
        );
        const start = samples.length;
        const rootBackground = over(tokenColor("--background"), [1, 1, 1, 1]);
        for (const [backgroundName, backgroundClass, backgroundToken] of backgrounds) {
          const host = node(backgroundClass, fixture, "div");
          host.textContent = "";
          let hostBackground = rgba(getComputedStyle(host).backgroundColor);
          let backgroundSource = "production-class";
          // Some Web surfaces are token aliases that no current route instantiates.
          // Record this explicitly rather than claiming an absent utility exists.
          if (hostBackground[3] === 0 && tokenColor(backgroundToken)[3] !== 0) {
            missingClasses.add(backgroundClass);
            host.style.backgroundColor = `var(${backgroundToken})`;
            hostBackground = rgba(getComputedStyle(host).backgroundColor);
            backgroundSource = "semantic-token-fallback";
          }
          const base = over(hostBackground, rootBackground);
          const cases = [
            { name: "primary-text", classes: "text-primary-text", textToken: "--primary-text" },
            {
              name: "inactive-tab-text",
              classes: "text-tab-inactive-foreground",
              textToken: "--tab-inactive-foreground",
            },
            {
              name: "muted-text",
              classes: "text-muted-foreground",
              textToken: "--muted-foreground",
            },
            {
              name: "danger-text",
              classes: "text-destructive-text",
              textToken: "--destructive-text",
            },
            {
              name: "primary-10pct-tint",
              classes: "bg-primary/10 text-primary-text",
              textToken: "--primary-text",
              tint: ["--primary", 0.1],
            },
            {
              name: "danger-5pct-tint",
              classes: "bg-destructive/5 text-destructive-text",
              textToken: "--destructive-text",
              tint: ["--destructive", 0.05],
            },
            {
              name: "danger-10pct-tint",
              classes: "bg-destructive/10 text-destructive-text",
              textToken: "--destructive-text",
              tint: ["--destructive", 0.1],
            },
            {
              name: "primary-button-normal",
              classes: primaryClasses,
              textToken: "--primary-foreground",
              button: true,
            },
            {
              name: "primary-button-hover-token",
              classes: primaryClasses,
              textToken: "--primary-foreground",
              button: true,
              hover: "--primary-hover",
            },
            {
              name: "primary-button-strong-hover-token",
              classes: primaryClasses,
              textToken: "--primary-foreground",
              button: true,
              hover: "--primary-hover-strong",
            },
            {
              name: "danger-button-normal",
              classes: dangerClasses,
              textToken:
                surface === "desktop" ? "--destructive-text" : "--destructive-control-foreground",
              button: true,
            },
            {
              name: "danger-button-hover-token",
              classes: dangerClasses,
              textToken:
                surface === "desktop" ? "--destructive-text" : "--destructive-control-foreground",
              button: true,
              hover: dangerHover,
            },
            {
              name: "solid-danger-normal",
              classes: "bg-destructive text-destructive-foreground",
              textToken: "--destructive-foreground",
              button: true,
            },
            {
              name: "solid-danger-hover-token",
              classes: "bg-destructive text-destructive-foreground",
              textToken: "--destructive-foreground",
              button: true,
              hover: "--destructive-hover",
            },
          ];
          for (const entry of cases) {
            const element = node(entry.classes, host, entry.button ? "button" : "span");
            let semanticFallback = false;
            if (entry.hover) element.style.backgroundColor = `var(${entry.hover})`;
            let style = getComputedStyle(element);
            let elementBackground = rgba(style.backgroundColor);
            if (entry.tint && elementBackground[3] === 0) {
              missingClasses.add(entry.classes.split(" ")[0]);
              element.style.backgroundColor = `color-mix(in srgb, var(${entry.tint[0]}) ${entry.tint[1] * 100}%, transparent)`;
              elementBackground = rgba(getComputedStyle(element).backgroundColor);
              semanticFallback = true;
            }
            const foreground = rgba(style.color);
            const expected = tokenColor(entry.textToken);
            if (!same(foreground, expected))
              integrations.push({
                theme,
                background: backgroundName,
                case: entry.name,
                reason: "Rendered text utility differs from its semantic token",
                actual: rounded(foreground),
                expected: rounded(expected),
              });
            const background = over(elementBackground, base);
            const renderedText = over(foreground, background);
            const ratio = contrast(renderedText, background);
            const sample = {
              theme,
              background: backgroundName,
              backgroundSource,
              case: entry.name,
              method: entry.hover
                ? "semantic-hover-token-simulation"
                : semanticFallback
                  ? "semantic-tint-fallback"
                  : "production-css-normal",
              classes: entry.classes,
              foreground: rounded(foreground),
              renderedText: rounded(renderedText),
              renderedBackground: rounded(background),
              computedColor: style.color,
              computedBackground: getComputedStyle(element).backgroundColor,
              contrast: Number(ratio.toFixed(6)),
              passes: ratio >= 4.5,
            };
            samples.push(sample);
            if (!sample.passes) failures.push(sample);
            element.remove();
          }
          host.remove();
        }
        const rows = samples.slice(start);
        states.push({
          theme,
          variables,
          samples: rows.length,
          minContrast: Math.min(...rows.map((row) => row.contrast)),
          failures: rows.filter((row) => !row.passes).length,
        });
      }
  } finally {
    fixture.remove();
    for (const [name, value] of Object.entries(saved)) {
      if (value === null) root.removeAttribute(name);
      else root.setAttribute(name, value);
    }
  }
  return {
    matrixVersion: 1,
    surface,
    summary: {
      themeCount: states.length,
      samples: samples.length,
      failed: failures.length,
      integrationFailures: integrations.length,
      minContrast: Math.min(...samples.map((sample) => sample.contrast)),
      precision: [...precision],
    },
    states,
    samples,
    failures,
    integrationFailures: integrations,
    missingBackgroundOrTintClasses: [...missingClasses],
    hoverBoundary:
      "Hover rows simulate the exact production tokens on a QA node. They do not force :hover or prove a compiled pseudo-class selector; use a real Playwright hover on the target specs below.",
    realHoverTargetSpecs: [
      {
        kind: "primary",
        selector: '[data-slot="button"][class~="hover:bg-[var(--primary-hover)]"]',
        backgroundToken: "--primary-hover",
        foregroundToken: "--primary-foreground",
      },
      {
        kind: "destructive",
        selector: `[data-slot="button"][class~="hover:bg-[var(${dangerHover})]"]`,
        backgroundToken: dangerHover,
        foregroundToken:
          surface === "desktop" ? "--destructive-text" : "--destructive-control-foreground",
      },
    ],
    restored: Object.entries(saved).every(([name, value]) => root.getAttribute(name) === value),
  };
}

// Visible QA controls for real Playwright hover. This modifies no application
// state; it temporarily selects CSS attributes and attaches independent nodes.
export function mountV15HoverFixture({
  surface = "desktop",
  accent = "vtron",
  mode = "light",
} = {}) {
  const accents =
    surface === "desktop"
      ? ["vtron", "minimal-neutral", "claude", "sakura", "ocean-breeze"]
      : ["blue", "violet", "green"];
  if (
    !["desktop", "web"].includes(surface) ||
    !accents.includes(accent) ||
    !["light", "dark"].includes(mode)
  )
    throw new Error("Invalid QA theme selection");
  if (document.getElementById("v15-qa-hover-fixture"))
    throw new Error("Unmount the existing QA hover fixture first");
  const root = document.documentElement;
  const saved = Object.fromEntries(
    ["class", "data-theme", "data-accent", "data-accent-theme"].map((name) => [
      name,
      root.getAttribute(name),
    ]),
  );
  const fixture = document.createElement("section");
  fixture.id = "v15-qa-hover-fixture";
  fixture.className = "bg-background text-foreground";
  fixture.setAttribute("data-v15-restore", JSON.stringify(saved));
  fixture.setAttribute("data-v15-surface", surface);
  fixture.setAttribute("data-v15-theme", `${accent}/${mode}`);
  fixture.setAttribute("aria-label", "Temporary QA contrast controls");
  fixture.style.cssText =
    "position:fixed;left:20px;top:20px;z-index:2147483647;display:flex;flex-wrap:wrap;align-items:center;gap:16px;width:min(620px,calc(100vw - 40px));padding:20px;border:1px solid var(--border);border-radius:12px;pointer-events:auto;";
  const add = (kind, tag, classes, text) => {
    const element = document.createElement(tag);
    element.id = `v15-qa-hover-${kind}`;
    element.setAttribute("data-v15-qa-kind", kind);
    element.className = classes;
    element.textContent = text;
    element.style.setProperty("transition", "none", "important");
    element.style.setProperty("animation", "none", "important");
    if (tag === "button") {
      element.type = "button";
      element.setAttribute("data-slot", "button");
    }
    fixture.append(element);
    return element;
  };
  try {
    if (surface === "desktop") {
      root.setAttribute("data-accent-theme", accent);
      root.setAttribute("data-theme", mode);
    } else {
      root.classList.toggle("dark", mode === "dark");
      root.setAttribute("data-accent", accent);
    }
    // Exact color variants from the two production Button modules. Do not set
    // inline color/background: real :hover must come from the generated CSS.
    const base =
      "inline-flex items-center justify-center h-9 rounded-md px-4 py-2 text-sm font-medium";
    add(
      "primary",
      "button",
      `${base} bg-primary text-primary-foreground hover:bg-[var(--primary-hover)]`,
      "QA primary",
    );
    add(
      "destructive",
      "button",
      `${base} ${surface === "desktop" ? "bg-[var(--destructive-soft)] text-destructive-text hover:bg-[var(--destructive-soft-hover)]" : "bg-[var(--destructive-control-bg)] text-[var(--destructive-control-foreground)] hover:bg-[var(--destructive-control-hover)]"}`,
      "QA destructive",
    );
    add("link", "button", "text-primary-text underline-offset-4 hover:underline", "QA link");
    add("metadata", "span", "text-sm text-muted-foreground", "QA metadata");
    add("inactive-tab", "button", "text-tab-inactive-foreground", "QA inactive tab");
    const permission = document.createElement("p");
    permission.className = "bg-destructive/10 text-destructive-text";
    fixture.append(permission);
    const previous = add("permission-previous", "span", "mt-1 block", "QA previous permission");
    permission.append(previous);
    const selected = add(
      "selected",
      "button",
      surface === "desktop"
        ? "segmented-control-item h-9 px-3"
        : "data-active:bg-background data-active:text-foreground dark:data-active:border-input dark:data-active:bg-input/30 dark:data-active:text-foreground text-sm rounded-md px-3 py-1",
      "QA selected",
    );
    selected.setAttribute("data-active", "");
    selected.setAttribute("aria-selected", "true");
    const input = add(
      "placeholder",
      "input",
      surface === "desktop"
        ? "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-base placeholder:text-muted-foreground md:text-sm dark:bg-input/30"
        : "h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base placeholder:text-muted-foreground md:text-sm dark:bg-input/30",
      "",
    );
    input.placeholder = "QA placeholder";
    input.readOnly = true;
    input.setAttribute("aria-label", "QA placeholder sample");
    document.body.append(fixture);
    return {
      surface,
      theme: `${accent}/${mode}`,
      primary: "#v15-qa-hover-primary",
      destructive: "#v15-qa-hover-destructive",
      fixture: "#v15-qa-hover-fixture",
    };
  } catch (error) {
    fixture.remove();
    for (const [name, value] of Object.entries(saved)) {
      if (value === null) root.removeAttribute(name);
      else root.setAttribute(name, value);
    }
    throw error;
  }
}

export function measureV15HoverFixture() {
  const fixture = document.getElementById("v15-qa-hover-fixture");
  if (!fixture) throw new Error("Mount the QA hover fixture first");
  const resolver = document.createElement("span");
  resolver.style.cssText = "position:absolute;left:-30000px;pointer-events:none;";
  fixture.append(resolver);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
  const methods = new Set();
  const number = (value) => (value.endsWith("%") ? Number.parseFloat(value) / 100 : Number(value));
  const direct = (value) => {
    const rgb = /^rgba?\((.*)\)$/i.exec(value);
    const srgb = /^color\(srgb\s+(.+)\)$/i.exec(value);
    if (!rgb && !srgb) return null;
    const values = (rgb ?? srgb)[1].replaceAll(",", " ").replaceAll("/", " ").trim().split(/\s+/);
    return [
      ...values
        .slice(0, 3)
        .map((component) =>
          rgb && !component.endsWith("%") ? Number(component) / 255 : number(component),
        ),
      values[3] ? number(values[3]) : 1,
    ];
  };
  const rgba = (value) => {
    let parsed = direct(value);
    let method = "computed-srgb-float";
    if (!parsed && CSS.supports("color", `color(from ${value} srgb r g b / alpha)`)) {
      resolver.style.color = `color(from ${value} srgb r g b / alpha)`;
      parsed = direct(getComputedStyle(resolver).color);
      method = "browser-relative-srgb-float";
    }
    if (
      parsed &&
      parsed.every(Number.isFinite) &&
      parsed.slice(0, 3).every((component) => component >= 0 && component <= 1)
    ) {
      methods.add(method);
      return parsed;
    }
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    try {
      const image = context.getImageData(0, 0, 1, 1, {
        colorSpace: "srgb",
        pixelFormat: "rgba-float16",
      });
      if (image.data.BYTES_PER_ELEMENT === 2) {
        methods.add("chromium-canvas-float16");
        return Array.from(image.data).map((component) => Math.max(0, Math.min(1, component)));
      }
    } catch {}
    methods.add("chromium-canvas-8bit-fallback");
    return Array.from(context.getImageData(0, 0, 1, 1).data).map((component) => component / 255);
  };
  const over = (top, bottom) => {
    const alpha = top[3] + bottom[3] * (1 - top[3]);
    return [
      ...[0, 1, 2].map((index) =>
        alpha ? (top[index] * top[3] + bottom[index] * bottom[3] * (1 - top[3])) / alpha : 0,
      ),
      alpha,
    ];
  };
  const luminance = (color) =>
    color
      .slice(0, 3)
      .reduce(
        (sum, component, index) =>
          sum +
          [0.2126, 0.7152, 0.0722][index] *
            (component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4),
        0,
      );
  try {
    const samples = [...fixture.querySelectorAll("[data-v15-qa-kind]")].map((element) => {
      const ancestors = [];
      for (let current = element; current; current = current.parentElement)
        ancestors.unshift(current);
      const background = ancestors.reduce(
        (color, current) => over(rgba(getComputedStyle(current).backgroundColor), color),
        [1, 1, 1, 1],
      );
      const kind = element.getAttribute("data-v15-qa-kind");
      const style = getComputedStyle(element, kind === "placeholder" ? "::placeholder" : null);
      const text = over(rgba(style.color), background);
      const values = [luminance(text), luminance(background)].sort((a, b) => b - a);
      const ratio = (values[0] + 0.05) / (values[1] + 0.05);
      return {
        kind,
        hovered: element.matches(":hover"),
        computedColor: style.color,
        computedBackground: getComputedStyle(element).backgroundColor,
        renderedText: text,
        renderedBackground: background,
        opacity: style.opacity,
        contrast: ratio,
        passes: ratio >= 4.5,
        classes: element.className,
      };
    });
    return {
      surface: fixture.getAttribute("data-v15-surface"),
      theme: fixture.getAttribute("data-v15-theme"),
      precision: [...methods],
      pointerMedia: {
        hover: matchMedia("(hover: hover)").matches,
        fine: matchMedia("(pointer: fine)").matches,
      },
      samples,
      failed: samples.filter((sample) => !sample.passes).length,
      actualHoveredButtons: samples
        .filter((sample) => ["primary", "destructive"].includes(sample.kind) && sample.hovered)
        .map((sample) => sample.kind),
      boundary:
        "Independent QA nodes using generated production CSS. :hover is reported from actual Chromium pseudo-class matching; no product button is clicked.",
    };
  } finally {
    resolver.remove();
  }
}

export function unmountV15HoverFixture() {
  const fixture = document.getElementById("v15-qa-hover-fixture");
  if (!fixture) return { removed: false, restored: true };
  const saved = JSON.parse(fixture.getAttribute("data-v15-restore"));
  fixture.remove();
  for (const [name, value] of Object.entries(saved)) {
    if (value === null) document.documentElement.removeAttribute(name);
    else document.documentElement.setAttribute(name, value);
  }
  return {
    removed: true,
    restored: Object.entries(saved).every(
      ([name, value]) => document.documentElement.getAttribute(name) === value,
    ),
  };
}
