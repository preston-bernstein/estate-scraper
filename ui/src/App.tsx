import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { Layout } from "./components/Layout";
import { LoginPage } from "./pages/LoginPage";
import { CallbackPage } from "./pages/CallbackPage";
import { DiscoverPage } from "./pages/DiscoverPage";
import { BrowsePage } from "./pages/BrowsePage";
import { CouchesPage } from "./pages/CouchesPage";
import { HistoryPage } from "./pages/HistoryPage";
import { HuntsPage } from "./pages/HuntsPage";
import { PlanPage } from "./pages/PlanPage";
import { SaleDetailPage } from "./pages/SaleDetailPage";

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/callback" element={<CallbackPage />} />
          <Route
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route index element={<DiscoverPage />} />
            <Route path="browse" element={<BrowsePage />} />
            <Route path="plan" element={<PlanPage />} />
            <Route path="hunts" element={<HuntsPage />} />
            <Route path="history" element={<HistoryPage />} />
            <Route path="couches" element={<CouchesPage />} />
            <Route path="sales/:id" element={<SaleDetailPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
