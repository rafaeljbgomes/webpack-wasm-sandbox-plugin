import { validateOrders } from "sandbox-workload/zod/validation";

function createOrders() {
  return Array.from({ length: 60 }, (_, index) => ({
    id: `order-${index + 1}`,
    customer: {
      name: `Customer ${index + 1}`,
      email: `customer${index + 1}@example.com`,
      tier: index % 4 === 0 ? "premium" : "standard",
    },
    items: [
      {
        sku: `sku-${index % 10}`,
        quantity: 1 + (index % 3),
        price: 12.5 + (index % 8),
      },
      {
        sku: `sku-${(index + 5) % 10}`,
        quantity: 1,
        price: 8.75,
      },
    ],
    coupon: index % 6 === 0 ? "SPRING10" : undefined,
    paid: index % 7 !== 0,
  }));
}

const orders = createOrders();
const invalidOrder = {
  id: "invalid",
  customer: {
    name: "",
    email: "not-an-email",
    tier: "standard",
  },
  items: [],
  paid: true,
};

export default function run() {
  const result = validateOrders(orders, invalidOrder);

  if (result.paidOrderCount === 0 || result.totalRevenue <= 0 || result.invalidAccepted) {
    throw new Error("Zod adapter scenario produced invalid validation output.");
  }
}
