import { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { fusionSetup } from "./setup.ts"

export default Plugin.define({
  id: "opencode-fusion",
  effect: (context) =>
    fusionSetup(context, {
      toolError: (message, error) => new Tool.Error({ message, ...(error !== undefined ? { error } : {}) }),
    }),
})
