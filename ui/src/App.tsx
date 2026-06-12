import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { BrowsePage } from "./pages/BrowsePage";
import { HistoryPage } from "./pages/HistoryPage";
import { HuntsPage } from "./pages/HuntsPage";
import { PlanPage } from "./pages/PlanPage";
import { SaleDetailPage } from "./pages/SaleDetailPage";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<BrowsePage />} />
          <Route path="plan" element={<PlanPage />} />
          <Route path="hunts" element={<HuntsPage />} />
          <Route path="history" element={<HistoryPage />} />
          <Route path="sales/:id" element={<SaleDetailPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
