"""Plain-language description of an assistant plan."""

from ...schemas.ai import AssistantPlan


def _plan_interpretation(plan: AssistantPlan) -> str:
    args = plan.arguments
    if plan.tool == "locate_item":
        return f"item: {args.get('q') or 'the item'}"
    if plan.tool == "count_items":
        return f"count of {args.get('q') or 'matching items'}"
    if plan.tool == "list_outstanding_loans":
        return "currently open loans"
    if plan.tool == "find_missing_information":
        return f"missing-information field: {args.get('field') or 'purchase'}"
    if plan.tool == "get_container_contents":
        label = args.get("identifier") or args.get("container_name") or "requested place"
        return f"container: {label}"
    if plan.tool == "list_room_contents":
        return f"room contents: {args.get('room_name') or 'requested room'}"
    if plan.tool == "get_warranty_status":
        return f"warranty status: {args.get('status') or 'all'}"
    if plan.tool == "search_documents":
        return f"documents matching: {args.get('q') or 'all'}"
    if plan.tool == "get_purchase_history":
        return f"purchase history: {args.get('merchant') or 'all'}"
    if plan.tool == "get_inventory_summary":
        return "inventory summary"
    if plan.tool == "list_borrowed_items":
        return "borrowed from others"
    if plan.tool == "find_borrowed_owner":
        return f"borrowed-item owner lookup: {args.get('q') or 'all'}"
    if plan.tool == "get_loan_history":
        borrower = args.get("borrower_name")
        return (
            f"loan history: {args.get('q') or args.get('item_id') or 'matching items'}"
            + (f" · borrower: {borrower}" if borrower else "")
        )
    return f"tool: {plan.tool}"
