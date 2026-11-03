const { chromium, devices } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const errs = [];
  for (const [name, ctxOpt] of [["desk", { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 }], ["phone", devices["iPhone 13"]]]) {
    const c = await b.newContext(ctxOpt), p = await c.newPage();
    p.on("pageerror", e => errs.push(name + ": " + e.message));
    await p.goto("http://localhost:8765/", { waitUntil: "load" });
    await p.waitForTimeout(9000);
    for (const id of ["dMix", "dCap"]) {
      const card = p.locator("#" + id).locator("xpath=ancestor::div[contains(@class,'card')][1]");
      await card.scrollIntoViewIfNeeded(); await p.waitForTimeout(300);
      await card.screenshot({ path: `${name}-${id}-0.png` });
      const box = await p.locator("#" + id).boundingBox();
      const x = box.x + box.width * 0.86, y = box.y + box.height * 0.42;
      if (name === "desk") await p.mouse.move(x, y); else await p.touchscreen.tap(x, y);
      await p.waitForTimeout(600);
      await card.screenshot({ path: `${name}-${id}-1.png` });
      const lg = p.locator(`#${id}`).locator("xpath=ancestor::div[contains(@class,'card')][1]").locator(".lg[data-i]");
      await lg.nth(3).click(); await p.waitForTimeout(200);
      if (name === "desk") await p.mouse.move(2, 2);
      await p.waitForTimeout(600);
      await card.screenshot({ path: `${name}-${id}-2.png` });
      console.log(name, id, "on:", await card.locator(".lg.on").count(), "pinned:", await card.locator(".lg[aria-pressed=true] span").allTextContents());
      await p.mouse.click(2, 2); await p.waitForTimeout(500);
      console.log(name, id, "after outside tap on:", await card.locator(".lg.on").count());
    }
  }
  console.log(errs.join("\n") || "no page errors");
  await b.close();
})();
