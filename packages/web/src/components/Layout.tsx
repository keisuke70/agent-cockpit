import { Outlet } from "react-router";

export function Layout() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        maxWidth: 768,
        margin: "0 auto",
      }}
    >
      <Outlet />
    </div>
  );
}
