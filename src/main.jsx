import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <div className="app-shell">
      <div className="app-main">
        <App />
      </div>

      {/* ✅ 항상 맨 아래 가운데 footer */}
      <footer className="app-footer">
        Made by Chatrue
      </footer>
    </div>
  </React.StrictMode>
);