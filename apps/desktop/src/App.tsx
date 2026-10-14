import { useLocation } from "./lib/router";
import { StoreProvider, useStore } from "./lib/store";
import { Shell } from "./components/Shell";
import { Home } from "./pages/Home";
import { Meetings } from "./pages/Meetings";
import { MeetingDetail } from "./pages/MeetingDetail";
import { ConfirmTodos } from "./pages/ConfirmTodos";
import { Todos } from "./pages/Todos";
import { Team } from "./pages/Team";
import { People } from "./pages/People";
import { Settings } from "./pages/Settings";
import { Welcome } from "./pages/Welcome";
import { Recorder } from "./pages/Recorder";
import { ArtGallery } from "./pages/ArtGallery";

export function App() {
  const { route } = useLocation();
  // The floating recorder is its own small window with its own copy of the state.
  if (route.name === "recorder") {
    return (
      <StoreProvider recorderWindow>
        <Recorder />
      </StoreProvider>
    );
  }
  return (
    <StoreProvider>
      <Screens />
    </StoreProvider>
  );
}

function Screens() {
  const { route } = useLocation();
  const store = useStore();

  if (route.name === "welcome") return <Welcome />;
  if (route.name === "art" && import.meta.env.DEV) return <ArtGallery />;

  const meetingTitle = (id: string) => store.meetings.find((m) => m.id === id)?.title ?? "会议";

  switch (route.name) {
    case "meetings":
      return <Shell crumbs={["工作空间", "会议"]}><Meetings /></Shell>;
    case "meeting":
      return <Shell crumbs={["会议", meetingTitle(route.id)]}><MeetingDetail id={route.id} /></Shell>;
    case "confirm":
      return <Shell crumbs={["会议", meetingTitle(route.id), "确认待办"]}><ConfirmTodos id={route.id} /></Shell>;
    case "todos":
      return <Shell crumbs={["工作空间", "待办"]}><Todos /></Shell>;
    case "team":
      return <Shell crumbs={["工作空间", "团队"]}><Team /></Shell>;
    case "people":
      return <Shell crumbs={["工作空间", "人员与声纹"]}><People /></Shell>;
    case "settings":
      return <Shell crumbs={["工作空间", "设置"]}><Settings /></Shell>;
    default:
      return <Shell crumbs={["工作空间", "工作台"]}><Home /></Shell>;
  }
}
