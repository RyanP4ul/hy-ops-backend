import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import type { InvoiceService } from "./service";
import { minorUnitsToMoney, moneyToMinorUnits } from "../../utils/money";

type Invoice = Awaited<ReturnType<typeof InvoiceService.getInvoiceByOrderId>>;

const money = (value: bigint | null) =>
  value === null ? "Unverified" : `PHP ${minorUnitsToMoney(value)}`;

function formatLabel(value?: string | null) {
  if (!value) return "Not specified";
  const overrides: Record<string, string> = {
    NET_30: "Net 30",
    FULLY_PAID: "Fully Paid",
    PARTIALLY_PAID: "Partially Paid",
    PAY_ON_DELIVERY: "Pay on Delivery",
    BANK_TRANSFER: "Bank Transfer",
    CASH: "Cash",
    CHEQUE: "Cheque",
    CHECK: "Check",
    GCASH: "GCash",
    E_WALLET: "E-Wallet",
    PAID: "Paid",
    UNPAID: "Unpaid",
    OVERDUE: "Overdue",
    UNVERIFIED: "Unverified",
    VOID: "Void",
  };
  if (overrides[value]) return overrides[value];
  return value
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatDate(date: string) {
  if (!date) return "-";
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat("en-PH", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  }).format(parsed);
}

/** Generate PDF bytes on the server using the same clean layout as Orders. */
export function buildInvoiceAttachment(invoice: Invoice) {
  const subtotal = invoice.items.some((item) => item.unit_price === null)
    ? null
    : invoice.items.reduce(
        (sum, item) =>
          sum + moneyToMinorUnits(item.unit_price ?? 0) * BigInt(item.quantity),
        0n,
      );
  const discount = moneyToMinorUnits(invoice.discount);
  const tax = moneyToMinorUnits(invoice.tax);
  const otherCharges = moneyToMinorUnits(invoice.other_charges);
  const paid = moneyToMinorUnits(invoice.amount_paid);
  const calculatedTotal =
    subtotal === null ? null : subtotal - discount + tax + otherCharges;
  const total =
    calculatedTotal === null
      ? null
      : calculatedTotal > 0n
        ? calculatedTotal
        : 0n;
  const balance = total === null ? null : total > paid ? total - paid : 0n;

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  doc.setCharSpace(0);

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 16;
  const right = pageWidth - margin;

  // Company heading
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.setTextColor(25, 25, 25);
  doc.text("HY COMPANY", margin, 22);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(95, 95, 95);
  doc.text("Guiguinto, Bulacan, Philippines", margin, 28);
  if (invoice.warehouse_name) {
    doc.text(`Warehouse: ${invoice.warehouse_name}`, margin, 33);
  }

  // Invoice title and key metadata on right
  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.setTextColor(25, 25, 25);
  doc.text(
    invoice.sales_channel === "WALK_IN" ? "WALK-IN INVOICE" : "INVOICE",
    right,
    22,
    { align: "right" },
  );

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(60, 60, 60);
  let metaY = 29;
  doc.text(`Invoice No.: ${invoice.invoice_number}`, right, metaY, {
    align: "right",
  });
  metaY += 5;
  if (invoice.order_number) {
    doc.text(`Order No.: ${invoice.order_number}`, right, metaY, {
      align: "right",
    });
    metaY += 5;
  }
  doc.text(`Issue Date: ${formatDate(invoice.issue_date)}`, right, metaY, {
    align: "right",
  });
  metaY += 5;
  if (invoice.payment_arrangement === "NET_30") {
    doc.text(`Due Date: ${formatDate(invoice.due_date)}`, right, metaY, {
      align: "right",
    });
    metaY += 5;
  }
  const statusLabel =
    invoice.status === "VOID"
      ? `Void (${formatLabel(invoice.payment_status)})`
      : formatLabel(invoice.payment_status);
  doc.setFont("helvetica", "bold");
  doc.text(`Status: ${statusLabel}`, right, metaY, { align: "right" });

  const dividerY = Math.max(42, metaY + 6);
  doc.setDrawColor(220, 220, 220);
  doc.line(margin, dividerY, right, dividerY);

  // Bill To & Payment Info
  const billToLines = [
    invoice.customer.company_name,
    invoice.customer.name,
    invoice.customer.address,
    invoice.customer.phone,
    invoice.customer.email,
  ].filter(Boolean);

  const methodDisplay = invoice.payment_method
    ? `${formatLabel(invoice.payment_method)}${invoice.payment_type ? ` (${invoice.payment_type})` : ""}`
    : "Not specified";

  const paymentLines = [
    `Terms: ${formatLabel(invoice.payment_arrangement)}`,
    `Method: ${methodDisplay}`,
    invoice.combined_payment
      ? `Combined Payment: ${invoice.combined_payment.payment_number}`
      : null,
    invoice.combined_payment?.reference_number
      ? `Reference: ${invoice.combined_payment.reference_number}`
      : null,
  ].filter(Boolean);

  autoTable(doc, {
    startY: dividerY + 4,
    margin: { left: margin, right: margin, bottom: 18 },
    head: [["BILL TO", "PAYMENT INFORMATION"]],
    body: [[billToLines.join("\n"), paymentLines.join("\n")]],
    theme: "plain",
    headStyles: {
      fontStyle: "bold",
      fontSize: 8.5,
      textColor: [95, 95, 95],
      cellPadding: { top: 2, right: 3, bottom: 1.5, left: 0 },
    },
    styles: {
      font: "helvetica",
      fontSize: 9,
      textColor: [35, 35, 35],
      cellPadding: { top: 1, right: 3, bottom: 2, left: 0 },
      overflow: "linebreak",
    },
    columnStyles: { 0: { cellWidth: 102 }, 1: { cellWidth: 76 } },
  });

  const lastY = () =>
    (doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable
      ?.finalY ?? 85;

  // Line items table
  autoTable(doc, {
    startY: lastY() + 6,
    margin: { left: margin, right: margin, bottom: 18 },
    head: [["Item", "SKU", "Qty", "Unit Price", "Amount"]],
    body: invoice.items.map((item) => {
      const price =
        item.unit_price === null ? null : moneyToMinorUnits(item.unit_price);
      const itemLabel = [item.name, item.variant_name, item.description]
        .filter(Boolean)
        .join("\n");
      return [
        itemLabel,
        item.sku || "-",
        item.quantity.toLocaleString("en-PH"),
        money(price),
        money(price === null ? null : price * BigInt(item.quantity)),
      ];
    }),
    theme: "grid",
    headStyles: {
      fillColor: [35, 45, 60],
      textColor: [255, 255, 255],
      fontStyle: "bold",
      fontSize: 8.5,
    },
    styles: {
      font: "helvetica",
      fontSize: 8.5,
      cellPadding: 2.8,
      overflow: "linebreak",
      textColor: [40, 40, 40],
      lineColor: [225, 225, 225],
      lineWidth: 0.2,
    },
    columnStyles: {
      0: { cellWidth: 62 },
      1: { cellWidth: 32 },
      2: { halign: "right", cellWidth: 16 },
      3: { halign: "right", cellWidth: 34 },
      4: { halign: "right", cellWidth: 34 },
    },
  });

  // Totals summary (omit always-zero discount/tax/other_charges rows)
  const totalsRows: [string, string][] = [["Subtotal", money(subtotal)]];
  if (discount > 0n) totalsRows.push(["Discount", `-${money(discount)}`]);
  if (tax > 0n) totalsRows.push(["Tax", money(tax)]);
  if (otherCharges > 0n) totalsRows.push(["Other Charges", money(otherCharges)]);
  totalsRows.push(["Total", money(total)]);
  totalsRows.push(["Amount Paid", money(paid)]);
  totalsRows.push(["Balance Due", money(balance)]);

  const totalRowIndex = totalsRows.findIndex(([label]) => label === "Total");
  const balanceRowIndex = totalsRows.length - 1;

  autoTable(doc, {
    startY: lastY() + 6,
    margin: { left: 112, right: margin, bottom: 18 },
    body: totalsRows,
    theme: "plain",
    styles: {
      font: "helvetica",
      fontSize: 9,
      cellPadding: { top: 2, right: 0, bottom: 2, left: 0 },
      textColor: [45, 45, 45],
    },
    columnStyles: { 1: { halign: "right" } },
    didParseCell: (hookData) => {
      if (
        hookData.row.index === totalRowIndex ||
        hookData.row.index === balanceRowIndex
      ) {
        hookData.cell.styles.fontStyle = "bold";
        hookData.cell.styles.fontSize = 10;
        hookData.cell.styles.textColor = [20, 20, 20];
      }
    },
  });

  if (invoice.notes) {
    autoTable(doc, {
      startY: lastY() + 6,
      margin: { left: margin, right: margin, bottom: 18 },
      head: [["NOTES"]],
      body: [[invoice.notes]],
      theme: "plain",
      headStyles: {
        fontStyle: "bold",
        fontSize: 8.5,
        textColor: [95, 95, 95],
        cellPadding: { top: 2, right: 0, bottom: 1, left: 0 },
      },
      styles: {
        font: "helvetica",
        fontSize: 9,
        textColor: [55, 55, 55],
        cellPadding: { top: 1, right: 0, bottom: 2, left: 0 },
        overflow: "linebreak",
      },
    });
  }

  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(125, 125, 125);
    doc.text(
      `${invoice.invoice_number} | Generated by HYOps`,
      margin,
      pageHeight - 9,
    );
    doc.text(`Page ${page} of ${pages}`, right, pageHeight - 9, {
      align: "right",
    });
  }

  return {
    filename: `${invoice.invoice_number.replace(/[^a-zA-Z0-9_.-]/g, "_")}.pdf`,
    contentType: "application/pdf",
    content: new Uint8Array(doc.output("arraybuffer")),
  };
}
