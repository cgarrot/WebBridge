import { toolRegistry } from "./registry.js";
import { NavigateTool } from "./navigate.js";
import { ScreenshotTool } from "./screenshot.js";
import { ClickTool } from "./click.js";
import { FillTool } from "./fill.js";
import { EvaluateTool } from "./evaluate.js";
import { SnapshotTool } from "./snapshot.js";
import { ListTabsTool, CloseTabTool, FindTabTool } from "./tab-manage.js";
import { SendKeysTool } from "./send-keys.js";
import { SaveAsPdfTool } from "./save-as-pdf.js";
import { UploadTool } from "./upload.js";

export function registerAllTools(): void {
  toolRegistry.register(new NavigateTool());
  toolRegistry.register(new ScreenshotTool());
  toolRegistry.register(new ClickTool());
  toolRegistry.register(new FillTool());
  toolRegistry.register(new EvaluateTool());
  toolRegistry.register(new SnapshotTool());
  toolRegistry.register(new ListTabsTool());
  toolRegistry.register(new CloseTabTool());
  toolRegistry.register(new FindTabTool());
  toolRegistry.register(new SendKeysTool());
  toolRegistry.register(new SaveAsPdfTool());
  toolRegistry.register(new UploadTool());
}

export { toolRegistry } from "./registry.js";
