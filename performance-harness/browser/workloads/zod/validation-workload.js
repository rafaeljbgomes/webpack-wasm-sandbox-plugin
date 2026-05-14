import { z } from "sandbox-real/zod";

const orderSchema = z.object({
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

export function validateOrders(orders, invalidOrder) {
  const parsedOrders = orders.map((order) => orderSchema.parse(order));
  const paidOrders = parsedOrders.filter((order) => order.paid);
  const totalRevenue = paidOrders.reduce(
    (sum, order) =>
      sum + order.items.reduce((orderSum, item) => orderSum + item.quantity * item.price, 0),
    0,
  );
  const invalidResult = orderSchema.safeParse(invalidOrder);

  return {
    paidOrderCount: paidOrders.length,
    totalRevenue,
    invalidAccepted: invalidResult.success,
  };
}
