import { toolRegistry } from "./registry.js";
// Existing tools
import { NavigateTool } from "./navigate.js";
import { ScreenshotTool } from "./screenshot.js";
import { ClickTool } from "./click.js";
import { FillTool } from "./fill.js";
import { EvaluateTool } from "./evaluate.js";
import { SnapshotTool } from "./snapshot.js";
import { ListTabsTool, CloseTabTool, FindTabTool, NewTabTool, SwitchTabTool, GetTabInfoTool } from "./tab-manage.js";
import { SendKeysTool } from "./send-keys.js";
import { SaveAsPdfTool } from "./save-as-pdf.js";
import { UploadTool } from "./upload.js";
// Phase 1: CUA tools
import { MoveTool } from "./move.js";
import { DoubleClickTool } from "./double-click.js";
import { HoverTool } from "./hover.js";
import { ScrollTool } from "./scroll.js";
import { DragTool } from "./drag.js";
// Phase 2: Tab navigation
import { BackTool, ForwardTool, ReloadTool } from "./tab-navigate.js";
// Phase 3: DOM CUA
import { GetVisibleDomTool, ClickElementTool, TypeElementTool, HighlightTool, ResolveObservedPhysicalTool } from "./dom-tools.js";
// Phase 7: Jev goal loop action space
import { ActionSpaceTool } from "./action-space.js";
import { GrantMediaPermissionsTool } from "./site-permissions.js";
// Meet audio + captions (files existed but were never registered → "Unknown tool")
import { TabAudioCaptureTool } from "./tab-audio-capture.js";
import { MeetCaptionExtractTool } from "./meet-caption-extract.js";
// Phase 4: Advanced
import { ClipboardTool } from "./clipboard.js";
import { ConsoleLogsTool } from "./console-logs.js";
import { WaitForTool } from "./wait-for.js";
import { ElementInfoTool } from "./element-info.js";
import { NetworkTool } from "./network.js";
import { ExtractLinksTool, ExtractTextTool, ExtractTableTool } from "./extract.js";
import { ReloadExtensionTool } from "./extension-lifecycle.js";
import { PreloadScriptTool } from "./preload-script.js";
import { PreloadNavigateTool } from "./preload-navigate.js";
// Virtual camera plugin
import { VirtualCameraTool } from "./virtual-camera/tool.js";

// Phase 5: Session & Tab Group UX
import { NameSessionTool, FinalizeTabsTool, ClaimTabTool, BrowserHistoryTool } from "./session-tools.js";

export function registerAllTools(): void {
  // Existing
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
  // CUA
  toolRegistry.register(new MoveTool());
  toolRegistry.register(new DoubleClickTool());
  toolRegistry.register(new HoverTool());
  toolRegistry.register(new ScrollTool());
  toolRegistry.register(new DragTool());
  // Tab management (new)
  toolRegistry.register(new NewTabTool());
  toolRegistry.register(new SwitchTabTool());
  toolRegistry.register(new GetTabInfoTool());
  toolRegistry.register(new BackTool());
  toolRegistry.register(new ForwardTool());
  toolRegistry.register(new ReloadTool());
  // DOM CUA
  toolRegistry.register(new GetVisibleDomTool());
  toolRegistry.register(new ResolveObservedPhysicalTool()); // J1b
  toolRegistry.register(new ClickElementTool());
  toolRegistry.register(new TypeElementTool());
  toolRegistry.register(new HighlightTool());
  // Jev goal loop (indexed action space for the daemon-side decision loop)
  toolRegistry.register(new ActionSpaceTool());
  toolRegistry.register(new GrantMediaPermissionsTool());
  toolRegistry.register(new TabAudioCaptureTool());
  toolRegistry.register(new MeetCaptionExtractTool());
  // Advanced
  toolRegistry.register(new ClipboardTool());
  toolRegistry.register(new ConsoleLogsTool());
  toolRegistry.register(new WaitForTool());
  toolRegistry.register(new ElementInfoTool());
  toolRegistry.register(new NetworkTool());
  toolRegistry.register(new ExtractLinksTool());
  toolRegistry.register(new ExtractTextTool());
  toolRegistry.register(new ExtractTableTool());
  toolRegistry.register(new ReloadExtensionTool());
  toolRegistry.register(new PreloadScriptTool());
  toolRegistry.register(new PreloadNavigateTool());
  // Session & Tab Group UX
  toolRegistry.register(new NameSessionTool());
  toolRegistry.register(new FinalizeTabsTool());
  toolRegistry.register(new ClaimTabTool());
  toolRegistry.register(new BrowserHistoryTool());
  toolRegistry.register(new VirtualCameraTool());
}

export { toolRegistry } from "./registry.js";
