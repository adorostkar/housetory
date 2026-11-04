import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import {
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";

import { AppShell } from "@/components/app-shell";
import { BootError, BootScreen } from "@/components/boot-screen";
import { Toaster } from "@/components/toaster";
import { UNAUTHORIZED_EVENT } from "@/lib/api";
import { queryKeys, useCanWrite, useSession } from "@/lib/queries";
import type { SessionState } from "@/lib/types";
import { ForgotPasswordPage } from "@/pages/forgot-password-page";
import { InvitationPage } from "@/pages/invitation-page";
import { LoginPage } from "@/pages/login-page";
import { NoHouseholdPage } from "@/pages/no-household-page";
import { ResetPasswordPage } from "@/pages/reset-password-page";
import { SetupPage } from "@/pages/setup-page";

const OverviewPage = React.lazy(() =>
  import("@/pages/overview-page").then((module) => ({ default: module.OverviewPage })),
);
const RoomsPage = React.lazy(() =>
  import("@/pages/rooms-page").then((module) => ({ default: module.RoomsPage })),
);
const RoomDetailPage = React.lazy(() =>
  import("@/pages/room-detail-page").then((module) => ({ default: module.RoomDetailPage })),
);
const ItemsPage = React.lazy(() =>
  import("@/pages/items-page").then((module) => ({ default: module.ItemsPage })),
);
const ItemNewPage = React.lazy(() =>
  import("@/pages/item-form-pages").then((module) => ({ default: module.ItemNewPage })),
);
const ItemEditPage = React.lazy(() =>
  import("@/pages/item-form-pages").then((module) => ({ default: module.ItemEditPage })),
);
const ItemDetailPage = React.lazy(() =>
  import("@/pages/item-detail-page").then((module) => ({ default: module.ItemDetailPage })),
);
const DocumentsPage = React.lazy(() =>
  import("@/pages/documents-page").then((module) => ({ default: module.DocumentsPage })),
);
const DocumentDetailPage = React.lazy(() =>
  import("@/pages/document-detail-page").then((module) => ({
    default: module.DocumentDetailPage,
  })),
);
const PurchasesPage = React.lazy(() =>
  import("@/pages/purchases-page").then((module) => ({ default: module.PurchasesPage })),
);
const WarrantiesPage = React.lazy(() =>
  import("@/pages/warranties-page").then((module) => ({ default: module.WarrantiesPage })),
);
const SearchPage = React.lazy(() =>
  import("@/pages/search-page").then((module) => ({ default: module.SearchPage })),
);
const ImportsPage = React.lazy(() =>
  import("@/pages/imports-page").then((module) => ({ default: module.ImportsPage })),
);
const ImportDetailPage = React.lazy(() =>
  import("@/pages/import-detail-page").then((module) => ({
    default: module.ImportDetailPage,
  })),
);
const AssistantPage = React.lazy(() =>
  import("@/pages/assistant-page").then((module) => ({ default: module.AssistantPage })),
);
const ScanPage = React.lazy(() =>
  import("@/pages/scan-page").then((module) => ({ default: module.ScanPage })),
);
const VoicePage = React.lazy(() =>
  import("@/pages/voice-page").then((module) => ({ default: module.VoicePage })),
);
const RecognitionPage = React.lazy(() =>
  import("@/pages/recognition-page").then((module) => ({
    default: module.RecognitionPage,
  })),
);
const ContainersPage = React.lazy(() =>
  import("@/pages/containers-page").then((module) => ({
    default: module.ContainersPage,
  })),
);
const ContainerDetailPage = React.lazy(() =>
  import("@/pages/container-detail-page").then((module) => ({
    default: module.ContainerDetailPage,
  })),
);
const LabelsPage = React.lazy(() =>
  import("@/pages/labels-page").then((module) => ({ default: module.LabelsPage })),
);
const SettingsPage = React.lazy(() =>
  import("@/pages/settings-page").then((module) => ({ default: module.SettingsPage })),
);
const AiSettingsPage = React.lazy(() =>
  import("@/pages/ai-settings-page").then((module) => ({ default: module.AiSettingsPage })),
);
const AccountSettingsPage = React.lazy(() =>
  import("@/pages/account-settings-page").then((module) => ({
    default: module.AccountSettingsPage,
  })),
);
const MembersSettingsPage = React.lazy(() =>
  import("@/pages/members-settings-page").then((module) => ({
    default: module.MembersSettingsPage,
  })),
);
const NotFoundPage = React.lazy(() =>
  import("@/pages/not-found-page").then((module) => ({ default: module.NotFoundPage })),
);

export default function App() {
  const session = useSession();
  const queryClient = useQueryClient();

  React.useEffect(() => {
    const onUnauthorized = () => {
      queryClient.setQueryData<SessionState>(queryKeys.session, (current) =>
        current
          ? {
              ...current,
              authenticated: false,
              user: null,
              household: null,
              role: null,
            }
          : current,
      );
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== "session",
      });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [queryClient]);

  if (session.isPending) return <BootScreen />;
  if (session.isError) {
    return <BootError onRetry={() => void session.refetch()} />;
  }

  const state = session.data;

  return (
    <>
      <Routes>
        <Route
          path="/setup"
          element={
            state.authenticated ? (
              <Navigate to="/" replace />
            ) : state.setup_required ? (
              <SetupPage />
            ) : (
              <Navigate to="/login" replace />
            )
          }
        />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password/:token" element={<ResetPasswordPage />} />
        <Route path="/invitations/:token" element={<InvitationPage />} />
        <Route
          path="/login"
          element={
            state.authenticated ? (
              <Navigate to="/" replace />
            ) : state.setup_required ? (
              <Navigate to="/setup" replace />
            ) : (
              <LoginPage />
            )
          }
        />
        <Route element={<RequireAuth />}>
          <Route element={<AppShell />}>
            <Route index element={<OverviewPage />} />
            <Route path="rooms" element={<RoomsPage />} />
            <Route path="rooms/:roomId" element={<RoomDetailPage />} />
            <Route path="items" element={<ItemsPage />} />
            <Route element={<RequireWriter />}>
              <Route path="items/new" element={<ItemNewPage />} />
              <Route path="items/:itemId/edit" element={<ItemEditPage />} />
            </Route>
            <Route path="items/:itemId" element={<ItemDetailPage />} />
            <Route path="documents" element={<DocumentsPage />} />
            <Route path="documents/:documentId" element={<DocumentDetailPage />} />
            <Route path="purchases" element={<PurchasesPage />} />
            <Route path="warranties" element={<WarrantiesPage />} />
            <Route element={<RequireWriter />}>
              <Route path="imports" element={<ImportsPage />} />
              <Route path="imports/:batchId" element={<ImportDetailPage />} />
            </Route>
            <Route path="assistant" element={<AssistantPage />} />
            <Route element={<RequireWriter />}>
              <Route path="scan" element={<ScanPage />} />
              <Route path="voice" element={<VoicePage />} />
              <Route path="recognize" element={<RecognitionPage />} />
            </Route>
            <Route path="containers" element={<ContainersPage />} />
            <Route path="containers/:containerId" element={<ContainerDetailPage />} />
            <Route element={<RequireWriter />}>
              <Route path="labels" element={<LabelsPage />} />
            </Route>
            <Route path="search" element={<SearchPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="settings/account" element={<AccountSettingsPage />} />
            <Route path="settings/members" element={<MembersSettingsPage />} />
            <Route path="settings/ai" element={<AiSettingsPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Route>
      </Routes>
      <Toaster />
    </>
  );
}

function RequireAuth() {
  const session = useSession();
  const location = useLocation();

  if (session.isPending) return <BootScreen />;
  if (!session.data?.authenticated) {
    if (session.data?.setup_required) {
      return <Navigate to="/setup" replace />;
    }
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  if (!session.data.household) {
    return <NoHouseholdPage />;
  }
  return <Outlet />;
}

function RequireWriter() {
  const canWrite = useCanWrite();
  if (!canWrite) return <Navigate to="/" replace />;
  return <Outlet />;
}
