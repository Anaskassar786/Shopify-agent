import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ProductsPage } from "./ProductsPage";
import { ProductDetailPage } from "./ProductDetailPage";
import { CustomersPage, customerDisplayName } from "./CustomersPage";
import { CustomerDetailPage } from "./CustomerDetailPage";
import { OrdersPage } from "./OrdersPage";
import { OrderDetailPage } from "./OrderDetailPage";
import { InventoryPage, stockTone } from "./InventoryPage";
import { pagedResponse, renderApp } from "../test-support/render";
import {
  CUSTOMER_ID,
  CUSTOMERS,
  customerDetail,
  INVENTORY_LEVELS,
  ORDER_ID,
  ORDERS,
  orderDetail,
  PRODUCT_ID,
  PRODUCTS,
  productDetail,
  storeResponse,
  VARIANTS,
} from "../test-support/fixtures";

describe("ProductsPage", () => {
  const handlers = {
    getWithMeta: { "/api/v1/products": () => pagedResponse(PRODUCTS) },
  };

  it("lists products with status badges and navigates to detail", async () => {
    renderApp(
      <Routes>
        <Route path="/products" element={<ProductsPage />} />
        <Route path="/products/:id" element={<p>product detail route</p>} />
      </Routes>,
      { route: "/products", handlers },
    );
    expect(await screen.findByText("Alpha Runner")).toBeInTheDocument();
    expect(screen.getByText("ACTIVE")).toBeInTheDocument();
    expect(screen.getByText("DRAFT")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Alpha Runner"));
    expect(await screen.findByText("product detail route")).toBeInTheDocument();
  });

  it("searches by title through the API and resets pagination", async () => {
    const { stub } = renderApp(<ProductsPage />, { route: "/products", handlers });
    await screen.findByText("Alpha Runner");
    fireEvent.change(screen.getByLabelText("Search products"), { target: { value: "alp" } });
    await waitFor(() =>
      expect(stub.calls.getWithMeta).toHaveBeenCalledWith("/api/v1/products", { page: 1, q: "alp" }),
    );
  });

  it("shows the honest empty state", async () => {
    renderApp(<ProductsPage />, {
      route: "/products",
      handlers: { getWithMeta: { "/api/v1/products": () => pagedResponse([]) } },
    });
    expect(await screen.findByText("No products synced yet")).toBeInTheDocument();
  });
});

describe("ProductDetailPage", () => {
  it("renders the synced product plus its variants table", async () => {
    renderApp(
      <Routes>
        <Route path="/products/:id" element={<ProductDetailPage />} />
      </Routes>,
      {
        route: `/products/${PRODUCT_ID}`,
        handlers: {
          get: {
            "/api/v1/store": () => storeResponse(),
            [`/api/v1/products/${PRODUCT_ID}`]: () => productDetail(),
            [`/api/v1/products/${PRODUCT_ID}/variants`]: () => VARIANTS,
          },
        },
      },
    );
    expect(await screen.findByRole("heading", { name: "Alpha Runner" })).toBeInTheDocument();
    expect(screen.getByText("ALP-42-BLK")).toBeInTheDocument();
    // Both variants are priced $199.00 — the table shows one row each.
    expect(screen.getAllByText("$199.00")).toHaveLength(2);
    // Shopify HTML renders as readable text, never injected markup.
    expect(screen.getByText(/Featherlight racing shoe\./)).toBeInTheDocument();
    expect(screen.getByText("gid://shopify/Product/7643")).toBeInTheDocument();
  });
});

describe("CustomersPage", () => {
  it("lists customers with spend and navigates to detail", async () => {
    renderApp(
      <Routes>
        <Route path="/customers" element={<CustomersPage />} />
        <Route path="/customers/:id" element={<p>customer detail route</p>} />
      </Routes>,
      {
        route: "/customers",
        handlers: {
          getWithMeta: { "/api/v1/customers": () => pagedResponse(CUSTOMERS) },
          get: { "/api/v1/store": () => storeResponse() },
        },
      },
    );
    expect(await screen.findByText("Sam Iyer")).toBeInTheDocument();
    expect(screen.getByText("$456.00")).toBeInTheDocument();
    expect(screen.getByText("Subscribed")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Sam Iyer"));
    expect(await screen.findByText("customer detail route")).toBeInTheDocument();
  });

  it("customerDisplayName falls back through name → email → guest", () => {
    expect(customerDisplayName({ firstName: "Sam", lastName: "Iyer", email: "x@y.z" })).toBe("Sam Iyer");
    expect(customerDisplayName({ firstName: null, lastName: null, email: "x@y.z" })).toBe("x@y.z");
    expect(customerDisplayName({ firstName: null, lastName: null, email: null })).toBe("Guest customer");
  });
});

describe("CustomerDetailPage", () => {
  it("shows lifetime metrics and recent orders", async () => {
    renderApp(
      <Routes>
        <Route path="/customers/:id" element={<CustomerDetailPage />} />
      </Routes>,
      {
        route: `/customers/${CUSTOMER_ID}`,
        handlers: {
          get: {
            "/api/v1/store": () => storeResponse(),
            [`/api/v1/customers/${CUSTOMER_ID}`]: () => customerDetail(),
          },
        },
      },
    );
    expect(await screen.findByRole("heading", { name: "Sam Iyer" })).toBeInTheDocument();
    expect(screen.getAllByText("$456.00").length).toBeGreaterThan(0);
    expect(screen.getByText("$65.14")).toBeInTheDocument(); // AOV
    expect(screen.getByText("#1042")).toBeInTheDocument(); // recent order
  });
});

describe("OrdersPage", () => {
  const handlers = {
    getWithMeta: { "/api/v1/orders": () => pagedResponse(ORDERS) },
  };

  it("lists orders with payment + fulfillment badges", async () => {
    renderApp(<OrdersPage />, { route: "/orders", handlers });
    await screen.findByText("#1042");
    expect(screen.getByText("$248.00")).toBeInTheDocument();
    // Badge texts also appear as select options — assert presence, scoped.
    expect(screen.getByText("paid", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText("fulfilled", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText("unfulfilled", { selector: "span" })).toBeInTheDocument();
  });

  it("filters by financial status server-side", async () => {
    const { stub } = renderApp(<OrdersPage />, { route: "/orders", handlers });
    await screen.findByText("#1042");
    fireEvent.change(screen.getByLabelText("Filter by payment status"), { target: { value: "paid" } });
    await waitFor(() =>
      expect(stub.calls.getWithMeta).toHaveBeenCalledWith("/api/v1/orders", { page: 1, financial_status: "paid" }),
    );
  });
});

describe("OrderDetailPage", () => {
  it("lists line items with computed line totals and the order summary", async () => {
    renderApp(
      <Routes>
        <Route path="/orders/:id" element={<OrderDetailPage />} />
      </Routes>,
      {
        route: `/orders/${ORDER_ID}`,
        handlers: {
          get: { [`/api/v1/orders/${ORDER_ID}`]: () => orderDetail() },
        },
      },
    );
    expect(await screen.findByRole("heading", { name: "Order #1042" })).toBeInTheDocument();
    expect(screen.getByText("Alpha Runner — 42 / Black")).toBeInTheDocument();
    // In this fixture the items subtotal equals the order total (199+49=248):
    // both summary rows render — assert the pair exists, not a singleton.
    expect(screen.getAllByText("$248.00")).toHaveLength(2);
    expect(screen.getAllByText("$199.00").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("sam@example.com")).toBeInTheDocument();
  });
});

describe("InventoryPage", () => {
  const handlers = {
    getWithMeta: { "/api/v1/inventory/levels": () => pagedResponse(INVENTORY_LEVELS) },
  };

  it("renders stock badges by threshold tone", async () => {
    renderApp(<InventoryPage />, { route: "/inventory", handlers });
    expect(await screen.findByText("-1 units")).toBeInTheDocument();
    expect(screen.getByText("3 units")).toBeInTheDocument();
    expect(screen.getByText("14 units")).toBeInTheDocument();
    expect(stockTone(-1)).toBe("danger");
    expect(stockTone(0)).toBe("danger");
    expect(stockTone(5)).toBe("warning");
    expect(stockTone(6)).toBe("success");
  });

  it("applies the below-threshold filter to the API call", async () => {
    const { stub } = renderApp(<InventoryPage />, { route: "/inventory", handlers });
    await screen.findByText("14 units");
    fireEvent.change(screen.getByLabelText("Only show stock below threshold"), { target: { value: "5" } });
    await waitFor(() =>
      expect(stub.calls.getWithMeta).toHaveBeenCalledWith("/api/v1/inventory/levels", { page: 1, below: 5 }),
    );
  });
});
