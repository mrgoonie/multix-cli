/**
 * Landing page behaviour: theme and language switches, copy button,
 * case-study players, pointer effects, and the lazy WebGL hero.
 * Everything here is an enhancement; the page works without it.
 */

type ThemePref = "auto" | "light" | "dark";

const THEME_KEY = "starlight-theme"; // shared with the Starlight docs
const LANG_KEY = "multix-lang";
const root = document.documentElement;
const lightQuery = matchMedia("(prefers-color-scheme: light)");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const finePointer = matchMedia("(hover: hover) and (pointer: fine)").matches;

const store = {
  get(key: string) {
    try {
      return localStorage.getItem(key) ?? "";
    } catch {
      return "";
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {}
  },
};

/* ---------- theme: Auto / Light / Dark ---------- */

const readPref = (): ThemePref => {
  const value = store.get(THEME_KEY);
  return value === "light" || value === "dark" ? value : "auto";
};

function applyTheme(pref: ThemePref) {
  root.dataset.theme = pref === "auto" ? (lightQuery.matches ? "light" : "dark") : pref;
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-set-theme]")) {
    button.setAttribute("aria-pressed", String(button.dataset.setTheme === pref));
  }
  dispatchEvent(new Event("mx-themechange"));
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-set-theme]")) {
  button.addEventListener("click", () => {
    const pref = (button.dataset.setTheme as ThemePref) ?? "auto";
    // Starlight stores Auto as an empty string; it reads anything else as auto too.
    store.set(THEME_KEY, pref === "auto" ? "" : pref);
    applyTheme(pref);
  });
}
lightQuery.addEventListener("change", () => {
  if (readPref() === "auto") applyTheme("auto");
});
applyTheme(readPref());

/* ---------- language: remember a manual choice ---------- */

for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-set-lang]")) {
  link.addEventListener("click", () => store.set(LANG_KEY, link.dataset.setLang ?? "en"));
}

/* ---------- copy button ---------- */

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-copy-target]")) {
  const source = document.getElementById(button.dataset.copyTarget ?? "");
  if (!source || !navigator.clipboard) continue;
  const label = button.textContent ?? "";
  button.hidden = false;
  // The button is a live region so screen readers hear "Copied" without losing focus.
  button.setAttribute("aria-live", "polite");
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(source.textContent ?? "");
      button.textContent = button.dataset.copied ?? label;
      setTimeout(() => {
        button.textContent = label;
      }, 1600);
    } catch {
      // Clipboard refused (permissions, insecure context): select the command to copy by hand.
      getSelection()?.selectAllChildren(source);
    }
  });
}

/* ---------- case studies: load the player only on click ---------- */

for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-video]")) {
  link.addEventListener("click", (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    const player = document.createElement("div");
    player.className = "mx-case-player";
    const src = link.dataset.video ?? link.href;
    const title = link.dataset.videoTitle ?? "";
    if (link.dataset.videoKind === "embed") {
      const frame = document.createElement("iframe");
      frame.src = src;
      frame.title = title;
      frame.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
      frame.allowFullscreen = true;
      player.append(frame);
    } else {
      const video = document.createElement("video");
      video.src = src;
      video.controls = true;
      video.autoplay = true;
      video.playsInline = true;
      video.poster = link.querySelector("img")?.src ?? "";
      video.setAttribute("aria-label", title);
      player.append(video);
    }
    link.replaceWith(player);
    player.querySelector<HTMLElement>("iframe, video")?.focus();
  });
}

/* ---------- pointer effects: spotlight and card tilt (desktop, motion allowed) ---------- */

if (finePointer && !reducedMotion) {
  let frame = 0;
  let x = 0;
  let y = 0;
  addEventListener(
    "pointermove",
    (event) => {
      x = event.clientX;
      y = event.clientY;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        root.style.setProperty("--mx-x", `${x}px`);
        root.style.setProperty("--mx-y", `${y}px`);
      });
    },
    { passive: true },
  );

  for (const card of document.querySelectorAll<HTMLElement>(".mx-tilt")) {
    card.addEventListener("pointermove", (event) => {
      const r = card.getBoundingClientRect();
      const px = (event.clientX - r.left) / r.width - 0.5;
      const py = (event.clientY - r.top) / r.height - 0.5;
      card.style.setProperty("--mx-ry", `${(px * 6).toFixed(2)}deg`);
      card.style.setProperty("--mx-rx", `${(-py * 6).toFixed(2)}deg`);
    });
    card.addEventListener("pointerleave", () => {
      card.style.removeProperty("--mx-rx");
      card.style.removeProperty("--mx-ry");
    });
  }
}

/* ---------- hero: start WebGL after first paint, once the stage is near the viewport ---------- */

const stage = document.getElementById("mx-stage");
if (stage && !reducedMotion) {
  const idle = (fn: () => void) =>
    "requestIdleCallback" in window
      ? requestIdleCallback(fn, { timeout: 1500 })
      : setTimeout(fn, 200);
  const start = () => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        import("./hero-renderer").then(({ startHero }) => startHero(stage)).catch(() => {});
      },
      { rootMargin: "200px" },
    );
    observer.observe(stage);
  };
  if (document.readyState === "complete") idle(start);
  else addEventListener("load", () => idle(start), { once: true });
}
