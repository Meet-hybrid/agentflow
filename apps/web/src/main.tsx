import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { Layout } from "./components/Layout.tsx";
import { Agents } from "./pages/Agents.tsx";
import { Arbiter } from "./pages/Arbiter.tsx";
import { CreateTask } from "./pages/CreateTask.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { Marketplace } from "./pages/Marketplace.tsx";
import { TaskDetail } from "./pages/TaskDetail.tsx";
import { SessionProvider } from "./session.tsx";
import "./styles.css";

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: <Marketplace /> },
      { path: "/tasks/new", element: <CreateTask /> },
      { path: "/tasks/:id", element: <TaskDetail /> },
      { path: "/dashboard", element: <Dashboard /> },
      { path: "/agents", element: <Agents /> },
      { path: "/arbiter", element: <Arbiter /> },
    ],
  },
]);

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <SessionProvider>
      <RouterProvider router={router} />
    </SessionProvider>
  </StrictMode>,
);
