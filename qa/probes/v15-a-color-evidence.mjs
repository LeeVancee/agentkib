// Pass this self-contained function to Playwright's page.evaluate. It observes
// actual Chromium styles without adding elements or changing application state.
export function collectV15ColorEvidence({ selector, maxNodes = 12 } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", {
    willReadFrequently: true,
    colorSpace: "srgb",
    colorType: "float16",
  });
  const precision = new Set();
  function rgba(value) {
    const rgb = /^rgba?\((.*)\)$/i.exec(value);
    if (rgb) {
      const parts = rgb[1].replaceAll(",", " ").replaceAll("/", " ").trim().split(/\s+/);
      precision.add("computed-rgb-float");
      return [
        ...parts
          .slice(0, 3)
          .map((part) =>
            part.endsWith("%") ? (Number.parseFloat(part) / 100) * 255 : Number(part),
          ),
        parts[3]
          ? parts[3].endsWith("%")
            ? Number.parseFloat(parts[3]) / 100
            : Number(parts[3])
          : 1,
      ];
    }
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    try {
      const pixels = context.getImageData(0, 0, 1, 1, {
        colorSpace: "srgb",
        pixelFormat: "rgba-float16",
      }).data;
      if (pixels.BYTES_PER_ELEMENT === 2) {
        precision.add(
          context.getContextAttributes().colorType === "float16"
            ? "chromium-canvas-float16"
            : "chromium-canvas-unorm8-to-float16",
        );
        return Array.from(pixels).map(
          (part, index) => Math.max(0, Math.min(1, part)) * (index < 3 ? 255 : 1),
        );
      }
    } catch {}
    precision.add("chromium-canvas-8bit-fallback");
    const pixel = context.getImageData(0, 0, 1, 1).data;
    return [pixel[0], pixel[1], pixel[2], pixel[3] / 255];
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
  const luminance = (rgb) =>
    rgb.slice(0, 3).reduce((sum, value, index) => {
      const component = value / 255;
      return (
        sum +
        [0.2126, 0.7152, 0.0722][index] *
          (component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4)
      );
    }, 0);
  const hex = (color) =>
    `#${color
      .slice(0, 3)
      .map((value) => Math.round(value).toString(16).padStart(2, "0"))
      .join("")}`;
  function renderedPixels(node, color) {
    let text = color;
    let base = [0, 0, 0, 0];
    const opacityLayers = [];
    const backgroundLayers = [];
    // Opacity applies to the whole element group, including its background.
    // Composite each group into its parent rather than treating text as opaque.
    for (let current = node; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      // The desktop's wide shell paints the content surface with ::after,
      // underneath its z-index:1 main. Ancestor backgrounds alone would read
      // the sidebar through that surface. Handle this known production layer;
      // this probe does not attempt to infer arbitrary CSS paint order.
      if (current.matches(".app-shell") && node.closest(".app-shell-main")) {
        const pseudo = getComputedStyle(current, "::after");
        const shell = current.getBoundingClientRect();
        const bounds = node.getBoundingClientRect();
        const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
        const left = shell.left + Number.parseFloat(pseudo.left);
        const top = shell.top + Number.parseFloat(pseudo.top);
        const right = left + Number.parseFloat(pseudo.width);
        const bottom = top + Number.parseFloat(pseudo.height);
        if (
          pseudo.content !== "none" &&
          pseudo.position === "absolute" &&
          pseudo.zIndex === "0" &&
          point.x > left + 16 &&
          point.x < right - 16 &&
          point.y > top + 16 &&
          point.y < bottom
        ) {
          const surface = rgba(pseudo.backgroundColor);
          surface[3] *= Number(pseudo.opacity);
          text = over(text, surface);
          base = over(base, surface);
          backgroundLayers.push({ selector: ".app-shell::after", color: pseudo.backgroundColor });
        }
      }
      const ownBackground = rgba(style.backgroundColor);
      text = over(text, ownBackground);
      base = over(base, ownBackground);
      const opacity = Number(style.opacity);
      text[3] *= opacity;
      base[3] *= opacity;
      if (opacity !== 1) opacityLayers.push(opacity);
    }
    const white = [255, 255, 255, 1];
    return {
      foreground: over(text, white),
      base: over(base, white),
      opacityLayers,
      backgroundLayers,
    };
  }
  const root = document.documentElement;
  const rootStyle = getComputedStyle(root);
  const variables = Object.fromEntries(
    [
      "--background",
      "--card",
      "--primary",
      "--primary-text",
      "--muted-foreground",
      "--destructive",
      "--destructive-icon",
    ].map((name) => [name, rootStyle.getPropertyValue(name).trim()]),
  );
  const selectors = {
    links: "a,[role=link]",
    primaryText: '[class*="text-primary"]',
    selected: "[aria-selected=true],[aria-current=page],[data-state=active]",
    mutedText: '[class*="text-muted-foreground"]',
    destructiveText: '[class*="text-destructive"]',
    destructiveButtons: 'button[class*="bg-destructive"]',
    primaryButtons: 'button[class*="bg-primary"]',
    readableMetadata: 'small,time,[role="tab"],[class*="opacity-"]',
  };
  const samples = [];
  for (const [kind, query] of Object.entries(selector ? { requested: selector } : selectors)) {
    const nodes = [...document.querySelectorAll(query)].filter((node) => {
      const bounds = node.getBoundingClientRect();
      return bounds.width && bounds.height && getComputedStyle(node).visibility !== "hidden";
    });
    for (const node of nodes.slice(0, maxNodes)) {
      const style = getComputedStyle(node);
      const { base, foreground, opacityLayers, backgroundLayers } = renderedPixels(
        node,
        rgba(style.color),
      );
      const [lighter, darker] = [luminance(foreground), luminance(base)].sort((a, b) => b - a);
      samples.push({
        kind,
        tag: node.tagName.toLowerCase(),
        disabled: node.matches(":disabled,[aria-disabled=true]"),
        text: (node.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 100),
        color: style.color,
        background: style.backgroundColor,
        renderedForeground: hex(foreground),
        renderedBackground: hex(base),
        contrast: Number(((lighter + 0.05) / (darker + 0.05)).toFixed(3)),
        fontSize: style.fontSize,
        opacity: style.opacity,
        opacityLayers,
        backgroundLayers,
      });
    }
  }
  return {
    title: document.title,
    language: root.lang,
    theme: root.dataset.theme,
    accent: root.dataset.accentTheme ?? root.dataset.accent,
    variables,
    precision: [...precision],
    samples,
  };
}
