import { useState } from "react";

// UI 开关类状态（无业务语义的展示态）。
// isMobile 不在此处——它已是独立 hook（useIsMobile），保持不动。
export function useUi() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);

  return {
    sidebarOpen,
    setSidebarOpen,
    modelPickerOpen,
    setModelPickerOpen,
  };
}
