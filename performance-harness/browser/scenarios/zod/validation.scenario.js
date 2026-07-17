import { z } from "zod";

function createOrderSchema() {
  return z.object({
    id: z.string().startsWith("order-"),
    customer: z.object({
      name: z.string().min(1),
      email: z.string().email(),
      tier: z.enum(["standard", "premium"]),
    }),
    items: z.array(
      z.object({
        sku: z.string().min(3),
        quantity: z.number().int().positive(),
        price: z.number().positive(),
      }),
    ).min(1),
    coupon: z.string().optional(),
    paid: z.boolean(),
  });
}

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
  const orderSchema = createOrderSchema();
  const parsedOrders = orders.map((order) => orderSchema.parse(order));
  const paidOrders = parsedOrders.filter((order) => order.paid);
  const totalRevenue = paidOrders.reduce(
    (sum, order) =>
      sum + order.items.reduce((orderSum, item) => orderSum + item.quantity * item.price, 0),
    0,
  );
  const invalidResult = orderSchema.safeParse(invalidOrder);

  if (paidOrders.length === 0 || totalRevenue <= 0 || invalidResult.success) {
    throw new Error("Zod scenario produced invalid validation output.");
  }
}
