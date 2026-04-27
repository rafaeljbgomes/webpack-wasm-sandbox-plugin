import _ from "lodash";

function createOrders() {
  return Array.from({ length: 120 }, (_, index) => {
    const region = ["north", "south", "east", "west"][index % 4];
    const status = index % 5 === 0 ? "cancelled" : "completed";

    return {
      id: `order-${index + 1}`,
      region,
      status,
      customer: {
        name: `Customer ${index + 1}`,
        tier: index % 3 === 0 ? "premium" : "standard",
      },
      total: 25 + (index % 12) * 8,
      items: [
        { sku: `sku-${index % 9}`, quantity: 1 + (index % 4) },
        { sku: `sku-${(index + 3) % 9}`, quantity: 1 + (index % 2) },
      ],
    };
  });
}

const orders = createOrders();

export default function run() {
  const completedOrders = _.filter(orders, { status: "completed" });
  const totalsByRegion = _.mapValues(
    _.groupBy(completedOrders, "region"),
    (regionOrders) => _.sumBy(regionOrders, "total"),
  );
  const premiumCustomerNames = _.chain(completedOrders)
    .filter((order) => order.customer.tier === "premium")
    .orderBy(["total", "customer.name"], ["desc", "asc"])
    .take(10)
    .map("customer.name")
    .value();
  const itemQuantities = _.chain(completedOrders)
    .flatMap("items")
    .groupBy("sku")
    .mapValues((items) => _.sumBy(items, "quantity"))
    .value();

  if (
    totalsByRegion.north <= 0 ||
    premiumCustomerNames.length === 0 ||
    Object.keys(itemQuantities).length === 0
  ) {
    throw new Error("Lodash scenario produced invalid aggregate output.");
  }
}
