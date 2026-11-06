import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "memory-preservation",
  async setup(ctx) {
    await ctx.session.hook("context", async (event) => {
      let rules: string
      try {
        rules = (await readFile(join(ctx.location.directory, ".agent/rules.md"), "utf8")).trim()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return
        throw error
      }

      if (rules) {
        event.system.unshift({
          type: "text",
          text: `[MANDATORY PROJECT RULES & CONSTRAINTS]\n${rules}`,
        })
      }
    })
  },
})
