import {test, expect} from '@playwright/test'

/**
 * Seeded by `factory scaffold` (Decision 39) — then PROJECT-OWNED. This file
 * demonstrates the shape the e2e-author agent is held to; replace it with
 * your own critical (money-path) journeys, or delete it once you have real
 * ones. Being in this directory (`e2e/`, per `e2e.testDir` config) IS what
 * makes a spec "critical" — there is no tag.
 *
 * Every critical spec needs exactly one `control:`-prefixed assertion that
 * passes on ANY boot of the app, regardless of whether a given feature
 * exists yet. The engine's fail-first proof runs this spec against the
 * unmodified base branch and expects the control assertion GREEN + every
 * other assertion RED — proof the app booted, not that it's broken.
 * See skills/e2e-authoring/SKILL.md for the full discipline.
 */
test('control: app shell renders', async ({page}) => {
    await page.goto('/')
    await expect(page).toHaveTitle(/.+/)
})

test.skip('example journey: replace with a real money-path', async ({page}) => {
    await page.goto('/')
    // await page.getByRole("link", { name: "Sign up" }).click();
    // await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
})
