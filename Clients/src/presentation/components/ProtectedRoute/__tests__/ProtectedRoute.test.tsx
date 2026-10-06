import { screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { http, HttpResponse } from "msw/http";
import { server } from "../../../../test/mocks/server";
import { queryClient } from "../../../../application/config/queryClient";
import { renderWithProviders } from "../../../../test/renderWithProviders";
import ProtectedRoute from "../index";

/**
 * A valid-looking JWT token for tests (not cryptographically valid).
 * Just needs to be a non-empty string so ProtectedRoute treats the user as authenticated.
 */
const TEST_AUTH_TOKEN = [
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  btoa(
    JSON.stringify({
      id: 1,
      email: "test@verifywise.com",
      name: "Test",
      surname: "User",
      organizationId: 1,
      tenantId: "abc123",
      roleName: "Admin",
      expire: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }),
  ),
  "test-signature",
].join(".");

// Dummy components for test routes
const Dashboard = () => <div data-testid="dashboard">Dashboard</div>;
const LoginPage = () => <div data-testid="login-page">Login</div>;

/** Helper that renders ProtectedRoute within a <Routes> so redirects work. */
function renderProtected(options: { route?: string; authToken?: string }) {
  return renderWithProviders(
    <Routes>
      <Route path="/" element={<ProtectedRoute Component={Dashboard} />} />
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/vendors"
        element={<ProtectedRoute Component={() => <div data-testid="vendors">Vendors</div>} />}
      />
    </Routes>,
    {
      route: options.route ?? "/",
      preloadedAuth: {
        authToken: options.authToken ?? "",
        userExists: true,
      },
    },
  );
}

describe("ProtectedRoute", () => {
  beforeEach(() => {
    // Suppress expected console.error from network errors in test environment
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("redirects to /login when there is no auth token", async () => {
    renderProtected({ route: "/", authToken: "" });

    await waitFor(() => {
      expect(screen.getByTestId("login-page")).toBeInTheDocument();
    });
  });

  it("renders the protected component when a valid auth token exists", async () => {
    renderProtected({ route: "/", authToken: TEST_AUTH_TOKEN });

    await waitFor(() => {
      expect(screen.getByTestId("dashboard")).toBeInTheDocument();
    });
  });

  it("redirects to /login for nested protected routes without token", async () => {
    renderProtected({ route: "/vendors", authToken: "" });

    await waitFor(() => {
      expect(screen.getByTestId("login-page")).toBeInTheDocument();
    });
  });

  it("renders nested protected route with valid token", async () => {
    renderProtected({ route: "/vendors", authToken: TEST_AUTH_TOKEN });

    await waitFor(() => {
      expect(screen.getByTestId("vendors")).toBeInTheDocument();
    });
  });

  it("clears auth and the query cache when the stored token fails validation", async () => {
    server.use(
      http.get("/api/users/:id", () =>
        HttpResponse.json({ message: "Unauthorized", data: "Invalid token" }, { status: 401 }),
      ),
    );
    queryClient.setQueryData(["projects"], [{ id: 1, name: "Previous user's project" }]);

    const { store } = renderProtected({ route: "/", authToken: TEST_AUTH_TOKEN });

    await waitFor(() => {
      expect(screen.getByTestId("login-page")).toBeInTheDocument();
    });
    expect(store.getState().auth.authToken).toBe("");
    expect(queryClient.getQueryData(["projects"])).toBeUndefined();
  });
});
