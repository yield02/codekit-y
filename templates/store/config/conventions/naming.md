# Naming convention — {{project}}

Team-owned and editable. Add rules by editing this file or by asking the AI (`naming_add_rule`).
Each rule has a stable ID; reference it in reviews (e.g. "violates NC-004").
`enforcedBy` names the linter rule that checks it, or `AI review` when no linter does.

## General

| ID | Scope | Rule | Correct | Incorrect | enforcedBy |
|---|---|---|---|---|---|
| NC-001 | Files & folders | Use kebab-case for folders and non-class files | `user-profile/`, `date-utils.ts` | `UserProfile/`, `date_utils.ts` | AI review |
| NC-002 | Booleans | Prefix with is/has/can/should | `isActive`, `hasAccess` | `active`, `access` | AI review |
| NC-003 | Abbreviations | Treat acronyms as words in camel/Pascal case | `HttpClient`, `userId` | `HTTPClient`, `userID` | AI review |
| NC-004 | Constants | UPPER_SNAKE_CASE for module-level constants | `MAX_RETRY_COUNT` | `maxRetryCount` | AI review |

## Node / TypeScript

| ID | Scope | Rule | Correct | Incorrect | enforcedBy |
|---|---|---|---|---|---|
| NC-101 | Types & classes | PascalCase, no `I` prefix for interfaces | `UserService`, `OrderDto` | `IUserService` | @typescript-eslint/naming-convention |
| NC-102 | Functions & variables | camelCase, verbs for functions | `fetchOrders()` | `orders_fetch()` | @typescript-eslint/naming-convention |

## Java / Spring

| ID | Scope | Rule | Correct | Incorrect | enforcedBy |
|---|---|---|---|---|---|
| NC-201 | Packages | All lowercase, reverse domain | `com.acme.order.service` | `com.acme.Order.Service` | Checkstyle PackageName |
| NC-202 | Spring beans | Suffix by role | `OrderService`, `OrderController`, `OrderRepository` | `OrderManager2` | AI review |

## .NET

| ID | Scope | Rule | Correct | Incorrect | enforcedBy |
|---|---|---|---|---|---|
| NC-301 | Interfaces | PascalCase with `I` prefix | `IOrderRepository` | `OrderRepositoryInterface` | .editorconfig IDE1006 |
| NC-302 | Private fields | `_camelCase` | `_orderService` | `orderService`, `m_orderService` | .editorconfig IDE1006 |
| NC-303 | Async methods | Suffix with `Async` | `GetOrderAsync()` | `GetOrder()` returning Task | AI review |

## Python

| ID | Scope | Rule | Correct | Incorrect | enforcedBy |
|---|---|---|---|---|---|
| NC-401 | Modules & functions | snake_case | `order_service.py`, `get_order()` | `OrderService.py`, `getOrder()` | ruff N |
| NC-402 | Classes | PascalCase | `OrderService` | `order_service` | ruff N801 |
