/** Designer-facing navigation only. Does not change checkout or payment states. */
export type ReviewGroup = 'flow' | 'results' | 'history' | 'extra';
export interface ReviewEntry {
  id: string;
  fixture: string;
  label: string;
  description: string;
  group: ReviewGroup;
  section: string;
  legacyIndex: number;
}
export const REVIEW_GROUPS: { id: ReviewGroup; label: string; description: string }[] = [
  { id: 'flow', label: 'Оплата по шагам', description: 'Основной путь пользователя: от выбора кошелька до чека.' },
  { id: 'results', label: 'Ошибки и результаты', description: 'Выберите ошибки внутри формы или отдельные результаты попытки оплаты.' },
  { id: 'history', label: 'История покупок', description: 'Список покупок и подробности каждой из них.' },
  { id: 'extra', label: 'Дополнительные проверки', description: 'Варианты ожидания, другие сети и проверки вёрстки. Для основного дизайна сюда заходить не обязательно.' },
];
export const REVIEW_ENTRIES: ReviewEntry[] = [
  {"id": "working", "fixture": "working", "label": "Подтверждение в кошельке", "description": "Пользователь подтверждает запрос в кошельке. Оплата ещё не подтверждена.", "group": "flow", "section": "Ожидание и восстановление", "legacyIndex": 0},
  {"id": "signing-wallet-unanswered-countdown", "fixture": "signing: wallet unanswered, countdown", "label": "Кошелёк не отвечает: таймер", "description": "Ждём ответа кошелька. Таймер оценивает, когда можно будет проверить завершение запроса.", "group": "extra", "section": "Ожидание и восстановление", "legacyIndex": 1},
  {"id": "waiting-for-the-payment", "fixture": "waiting for the payment", "label": "Подтверждение в сети", "description": "Запрос отправлен. Проверяем результат платежа в блокчейне.", "group": "flow", "section": "Ожидание и восстановление", "legacyIndex": 2},
  {"id": "waiting-for-the-store", "fixture": "waiting for the store", "label": "Ожидание магазина", "description": "Платёж уже получен. Ждём, когда магазин завершит заказ.", "group": "flow", "section": "Ожидание и восстановление", "legacyIndex": 3},
  {"id": "payment-complete", "fixture": "payment complete", "label": "Успешная оплата", "description": "Заказ завершён. Показываем чек и дальнейшие действия.", "group": "flow", "section": "Ожидание и восстановление", "legacyIndex": 4},
  {"id": "your-purchases-3", "fixture": "your purchases: 3", "label": "Список покупок", "description": "Несколько покупок с разными статусами. Нажатие открывает детали.", "group": "history", "section": "Ожидание и восстановление", "legacyIndex": 5},
  {"id": "your-purchases-detail-delivered", "fixture": "your purchases: detail delivered", "label": "Детали успешной покупки", "description": "Сумма, статус, дата и данные чека одной завершённой покупки.", "group": "history", "section": "Ожидание и восстановление", "legacyIndex": 6},
  {"id": "loading", "fixture": "loading", "label": "Загрузка", "description": "Начальная загрузка данных товара и магазина.", "group": "extra", "section": "Другие варианты оплаты", "legacyIndex": 7},
  {"id": "offer", "fixture": "offer", "label": "Выбор способа оплаты", "description": "Начало оплаты: сумма, сеть и доступные кошельки.", "group": "flow", "section": "Ожидание и восстановление", "legacyIndex": 8},
  {"id": "offer-two-networks-email", "fixture": "offer: two networks, email", "label": "Несколько сетей и email", "description": "Проверка выбора сети и необязательного поля email.", "group": "extra", "section": "Другие варианты оплаты", "legacyIndex": 9},
  {"id": "offer-the-payout-list-open", "fixture": "offer: the payout list open", "label": "Открытый список сетей", "description": "Проверка раскрытого списка способов оплаты.", "group": "extra", "section": "Другие варианты оплаты", "legacyIndex": 10},
  {"id": "offer-earlier-payment-confirming-countdown", "fixture": "offer: earlier payment confirming, countdown", "label": "Предыдущая оплата: таймер", "description": "Прежняя попытка ещё подтверждается. Новый платёж пока не запускаем.", "group": "extra", "section": "Ожидание и восстановление", "legacyIndex": 11},
  {"id": "offer-earlier-payment-confirming-in-a-moment", "fixture": "offer: earlier payment confirming, in a moment", "label": "Предыдущая оплата: без таймера", "description": "Прежняя попытка проверяется, но точный срок ещё неизвестен.", "group": "extra", "section": "Ожидание и восстановление", "legacyIndex": 12},
  {"id": "offer-earlier-tempo-request-open-countdown", "fixture": "offer: earlier Tempo request open, countdown", "label": "Предыдущий запрос Tempo: таймер", "description": "В кошельке остаётся прежний запрос Tempo. Он ещё может быть подтверждён.", "group": "extra", "section": "Ожидание и восстановление", "legacyIndex": 13},
  {"id": "offer-earlier-tempo-request-open-in-a-moment", "fixture": "offer: earlier Tempo request open, in a moment", "label": "Предыдущий запрос Tempo: без таймера", "description": "Проверяем прежний запрос Tempo без точного времени завершения.", "group": "extra", "section": "Ожидание и восстановление", "legacyIndex": 14},
  {"id": "offer-earlier-payment-waiting-for-the-store", "fixture": "offer: earlier payment waiting for the store", "label": "Предыдущая оплата ожидает магазин", "description": "Предыдущий платёж уже пришёл, но магазин ещё не завершил заказ.", "group": "extra", "section": "Ожидание и восстановление", "legacyIndex": 15},
  {"id": "offer-earlier-payment-cancelled-by-the-store", "fixture": "offer: earlier payment, cancelled by the store", "label": "Предыдущая оплата: заказ отменён", "description": "Оплата уже поступила, а магазин отменил заказ. Возврат не подтверждён.", "group": "extra", "section": "Ожидание и восстановление", "legacyIndex": 16},
  {"id": "offer-a-changed-price-choose-wallet", "fixture": "offer: a changed price (Choose wallet)", "label": "Изменившаяся цена", "description": "Магазин изменил предложение. Перед оплатой нужно заново проверить условия.", "group": "extra", "section": "Другие варианты оплаты", "legacyIndex": 17},
  {"id": "offer-tempo-mainnet", "fixture": "offer: Tempo mainnet", "label": "Оплата через Tempo", "description": "Вариант главного экрана с сетью Tempo и кошельком MetaMask.", "group": "extra", "section": "Другие варианты оплаты", "legacyIndex": 18},
  {"id": "offer-a-wallet-without-tempo", "fixture": "offer: a wallet without Tempo", "label": "Кошелёк не поддерживает сеть", "description": "Выбранный кошелёк не поддерживает сеть. Нажмите на его строку, чтобы выбрать другой. Оплата ещё не началась.", "group": "results", "section": "Ошибка при выборе кошелька", "legacyIndex": 20},
  {"id": "offer-a-problem", "fixture": "offer: a problem", "label": "Изменившееся предложение", "description": "Вариант уведомления об изменившихся условиях на одной сети.", "group": "extra", "section": "Другие варианты оплаты", "legacyIndex": 21},
  {"id": "no-wallet", "fixture": "no wallet", "label": "Кошелёк не найден", "description": "В браузере нет подходящего кошелька. Показываем доступные варианты установки.", "group": "results", "section": "Ошибка при выборе кошелька", "legacyIndex": 22},
  {"id": "working-waiting-for-the-wallet", "fixture": "working: waiting for the wallet", "label": "Подключение кошелька", "description": "Получаем аккаунт и проверяем готовность кошелька. Пользователь может отменить подключение.", "group": "flow", "section": "Ожидание и восстановление", "legacyIndex": 23},
  {"id": "working-the-wallet-has-not-answered", "fixture": "working: the wallet has not answered", "label": "Подключение занимает долго", "description": "Кошелёк не отвечает при подключении. Появляется подсказка и возможность отмены.", "group": "extra", "section": "Ожидание и восстановление", "legacyIndex": 24},
  {"id": "signing-wallet-unanswered-no-estimate-yet", "fixture": "signing: wallet unanswered, no estimate yet", "label": "Нет ответа: срок неизвестен", "description": "Ожидание подтверждения в кошельке без точной оценки времени.", "group": "extra", "section": "Ожидание и восстановление", "legacyIndex": 25},
  {"id": "signing-wallet-unanswered-0-00-checking", "fixture": "signing: wallet unanswered, 0:00 (checking)", "label": "Нет ответа: таймер истёк", "description": "Таймер дошёл до нуля. Checkout проверяет, закончился ли запрос.", "group": "extra", "section": "Ожидание и восстановление", "legacyIndex": 26},
  {"id": "signing-wallet-unanswered-taking-long", "fixture": "signing: wallet unanswered, taking long", "label": "Нет ответа: долгое ожидание", "description": "Запрос остаётся неразрешённым дольше ожидаемого срока. Это ещё не доказательство отказа.", "group": "extra", "section": "Ожидание и восстановление", "legacyIndex": 27},
  {"id": "signing-tempo-request-unanswered-countdown", "fixture": "signing: Tempo request unanswered, countdown", "label": "Нет ответа от Tempo", "description": "Ожидаем подтверждения запроса Tempo. Срок ожидания отличается от Solana.", "group": "extra", "section": "Ожидание и восстановление", "legacyIndex": 28},
  {"id": "wallet-did-not-sign-retry-countdown", "fixture": "wallet did not sign: retry countdown", "label": "Нет подписи: повтор пока закрыт", "description": "Подпись не получена. Новый платёж разрешается только после проверки предыдущей попытки.", "group": "extra", "section": "Ожидание и восстановление", "legacyIndex": 29},
  {"id": "retry", "fixture": "retry", "label": "Платёж не прошёл", "description": "Проверено, что оплаты не было. Можно выбрать кошелёк и повторить попытку.", "group": "results", "section": "Результат попытки", "legacyIndex": 30},
  {"id": "follow-only-start-over-countdown", "fixture": "follow-only: start over countdown", "label": "Наблюдение за прежним заказом", "description": "Этот экран только следит за попыткой. Начать заново можно после проверки её завершения.", "group": "extra", "section": "Ожидание и восстановление", "legacyIndex": 31},
  {"id": "network-not-checked-here", "fixture": "network not checked here", "label": "Сеть не проверяется здесь", "description": "У checkout нет возможности проверить эту сеть. Нельзя делать вывод, что оплаты не было.", "group": "extra", "section": "Ожидание и восстановление", "legacyIndex": 32},
  {"id": "tempo-request-countdown", "fixture": "Tempo: request countdown", "label": "Запрос Tempo ожидает ответа", "description": "Ждём подтверждения или отклонения запроса в кошельке Tempo.", "group": "extra", "section": "Ожидание и восстановление", "legacyIndex": 33},
  {"id": "offer-base-sepolia-sign-then-confirm", "fixture": "offer: Base Sepolia (sign, then confirm)", "label": "Base: выбор кошелька", "description": "Дополнительная сеть Base Sepolia: сначала подпись, затем подтверждение отправки.", "group": "extra", "section": "Base и EIP-3009", "legacyIndex": 34},
  {"id": "offer-base-hidden-while-a-fee-is-on-e7", "fixture": "offer: Base hidden while a fee is on (E7)", "label": "Base: ограничение комиссии", "description": "При определённых условиях комиссии способы EIP-3009 скрываются из выбора.", "group": "extra", "section": "Base и EIP-3009", "legacyIndex": 35},
  {"id": "base-sent-confirming-same-wallet-at-once", "fixture": "Base: sent, confirming, same wallet at once", "label": "Base: платёж отправлен", "description": "Проверяем отправленный платёж. Особая логика допускает повтор тем же кошельком.", "group": "extra", "section": "Base и EIP-3009", "legacyIndex": 36},
  {"id": "base-found-confirming", "fixture": "Base: found, confirming", "label": "Base: транзакция найдена", "description": "Транзакция найдена в сети и ожидает подтверждения.", "group": "extra", "section": "Base и EIP-3009", "legacyIndex": 37},
  {"id": "base-send-declined-send-again", "fixture": "Base: send declined, send again", "label": "Base: отправка отклонена", "description": "Пользователь отклонил отправку. Сохранённую подпись можно отправить снова.", "group": "extra", "section": "Base и EIP-3009", "legacyIndex": 38},
  {"id": "base-not-enough-eth-send-anyway", "fixture": "Base: not enough ETH, send anyway", "label": "Base: мало ETH на комиссию", "description": "В кошельке недостаточно ETH для сетевой комиссии. Показываем доступные действия.", "group": "extra", "section": "Base и EIP-3009", "legacyIndex": 39},
  {"id": "base-checking-the-signature-expired", "fixture": "Base: checking the signature expired", "label": "Base: срок подписи истёк", "description": "Проверяем, что подпись истекла и не была использована.", "group": "extra", "section": "Base и EIP-3009", "legacyIndex": 40},
  {"id": "base-another-wallet", "fixture": "Base: another wallet", "label": "Base: другой кошелёк", "description": "Предыдущая авторизация завершилась без использования. Можно оплатить другим кошельком.", "group": "extra", "section": "Base и EIP-3009", "legacyIndex": 41},
  {"id": "base-nonce-used-outside-the-checkout", "fixture": "Base: nonce used outside the checkout", "label": "Base: оплата вне виджета", "description": "Авторизация использована вне checkout. Новый платёж запускать нельзя, ждём магазин.", "group": "extra", "section": "Base и EIP-3009", "legacyIndex": 42},
  {"id": "paid-cancelled", "fixture": "paid, cancelled", "label": "Оплаченный заказ отменён", "description": "Деньги уже отправлены, но магазин отменил заказ. Это не то же самое, что отмена без оплаты.", "group": "results", "section": "Результат попытки", "legacyIndex": 43},
  {"id": "old-prompt", "fixture": "old prompt", "label": "Старый запрос в кошельке", "description": "Предупреждаем, что подтверждение прежнего запроса может оплатить старый заказ.", "group": "extra", "section": "Ожидание и восстановление", "legacyIndex": 44},
  {"id": "payment-complete-tempo", "fixture": "payment complete: Tempo", "label": "Успешная оплата Tempo", "description": "Проверка того же экрана успеха для транзакции Tempo.", "group": "extra", "section": "Другие варианты оплаты", "legacyIndex": 45},
  {"id": "refunded", "fixture": "refunded", "label": "Возврат", "description": "Магазин отметил заказ как возвращённый. Показываем статус и чек.", "group": "results", "section": "Результат попытки", "legacyIndex": 46},
  {"id": "payment-complete-the-store-answered-first-transaction-sent", "fixture": "payment complete: the store answered first (transaction sent)", "label": "Магазин ответил раньше проверки", "description": "Магазин завершил заказ, а виджет ещё обрабатывает сведения об отправленной транзакции.", "group": "extra", "section": "Другие варианты оплаты", "legacyIndex": 47},
  {"id": "offer-a-long-product-name", "fixture": "offer: a long product name", "label": "Длинное название товара", "description": "Проверяем переносы и сокращения длинных названий товара и магазина.", "group": "extra", "section": "Длинные тексты и анимация", "legacyIndex": 48},
  {"id": "offer-a-long-verified-domain", "fixture": "offer: a long verified domain", "label": "Длинный домен магазина", "description": "Пример с длинным именем магазина и доменом. Метка домена в этой галерее скрыта.", "group": "extra", "section": "Длинные тексты и анимация", "legacyIndex": 49},
  {"id": "cancelled", "fixture": "cancelled", "label": "Заказ отменён без оплаты", "description": "Магазин отменил заказ. Ничего не оплачено, можно начать новый заказ.", "group": "results", "section": "Результат попытки", "legacyIndex": 50},
  {"id": "blocked", "fixture": "blocked", "label": "Платёж заблокирован", "description": "Средства заблокированы политикой получателя. Их нельзя считать неоплаченными.", "group": "results", "section": "Результат попытки", "legacyIndex": 51},
  {"id": "refused", "fixture": "refused", "label": "Товар нельзя купить здесь", "description": "Магазин не разрешает покупку в этом контексте, например на другом домене.", "group": "results", "section": "Результат попытки", "legacyIndex": 52},
  {"id": "sold-out", "fixture": "sold-out", "label": "Товар недоступен", "description": "Продажа товара остановлена. Новый заказ оформить нельзя.", "group": "results", "section": "Результат попытки", "legacyIndex": 53},
  {"id": "your-purchases-0", "fixture": "your purchases: 0", "label": "Пустая история", "description": "В этом браузере ещё нет покупок из данного магазина.", "group": "history", "section": "Ожидание и восстановление", "legacyIndex": 54},
  {"id": "your-purchases-40", "fixture": "your purchases: 40", "label": "Длинная история", "description": "Проверяем прокрутку и действия на списке из 40 покупок.", "group": "history", "section": "Ожидание и восстановление", "legacyIndex": 55},
  {"id": "your-purchases-detail-refunded", "fixture": "your purchases: detail refunded", "label": "Детали возврата", "description": "Данные и чек возвращённой покупки.", "group": "history", "section": "Ожидание и восстановление", "legacyIndex": 56},
  {"id": "your-purchases-detail-waiting-store", "fixture": "your purchases: detail waiting_store", "label": "Детали: ожидаем магазин", "description": "Оплата поступила, но магазин ещё не завершил покупку.", "group": "history", "section": "Ожидание и восстановление", "legacyIndex": 57},
  {"id": "your-purchases-detail-paying", "fixture": "your purchases: detail paying", "label": "Детали незавершённой оплаты", "description": "Данные платежа, который всё ещё проверяется.", "group": "history", "section": "Ожидание и восстановление", "legacyIndex": 58},
  {"id": "your-purchases-detail-blocked", "fixture": "your purchases: detail blocked", "label": "Детали блокировки", "description": "Покупка, платёж которой заблокирован получателем.", "group": "history", "section": "Ожидание и восстановление", "legacyIndex": 59},
  {"id": "your-purchases-detail-cancelled-paid", "fixture": "your purchases: detail cancelled_paid", "label": "Детали оплаченной отмены", "description": "Магазин отменил оплаченный заказ. Подтверждения возврата нет.", "group": "history", "section": "Ожидание и восстановление", "legacyIndex": 60},
  {"id": "your-purchases-detail-with-a-sent-transaction", "fixture": "your purchases: detail with a sent transaction", "label": "Обновление транзакции в чеке", "description": "Техническая проверка: при открытии деталей появляются обновлённые сведения об отправленной транзакции.", "group": "extra", "section": "Данные чека и обновление", "legacyIndex": 61},
  {"id": "progress-finishing-the-last-stage-filled-held", "fixture": "progress: finishing (the last stage filled, held)", "label": "Переход к успешной оплате", "description": "Проверяем короткое заполнение последнего шага перед экраном успеха.", "group": "extra", "section": "Длинные тексты и анимация", "legacyIndex": 62},
  {"id": "creating-order", "fixture": "review: creating order", "label": "Создание заказа", "description": "Отправляем заказ магазину. Подтверждение платежа в кошельке ещё впереди.", "group": "flow", "section": "", "legacyIndex": 63},
  {"id": "forty-wallets", "fixture": "review: forty wallets", "label": "40 кошельков: поиск и прокрутка", "description": "Проверка длинного списка: найдите и выберите кошелёк, затем нажмите Pay. Выбор сам по себе не запускает оплату.", "group": "extra", "section": "Длинные тексты и анимация", "legacyIndex": 64},
];

const FLOW_ORDER = ['offer', 'working-waiting-for-the-wallet', 'creating-order', 'working', 'waiting-for-the-payment', 'waiting-for-the-store', 'payment-complete'];
export function entriesForGroup(group: ReviewGroup): ReviewEntry[] {
  const entries = REVIEW_ENTRIES.filter((entry) => entry.group === group);
  if (group === 'flow') {return entries.sort((a, b) => FLOW_ORDER.indexOf(a.id) - FLOW_ORDER.indexOf(b.id));}
  if (group === 'extra') {
    const sections = ['Ожидание и восстановление', 'Другие варианты оплаты', 'Base и EIP-3009', 'Длинные тексты и анимация', 'Данные чека и обновление'];
    return entries.sort((a, b) => sections.indexOf(a.section) - sections.indexOf(b.section));
  }
  return entries;
}
export function initialReviewEntry(params: URLSearchParams): ReviewEntry {
  const stable = REVIEW_ENTRIES.find((entry) => entry.id === params.get('state'));
  if (stable) {return stable;}
  const legacy = params.get('screen');
  if (legacy !== null) {
    const index = Number(legacy);
    const entry = REVIEW_ENTRIES.find((entry) => entry.legacyIndex === (index === 19 ? 18 : index));
    if (entry) {return entry;}
  }
  return entriesForGroup('flow')[0]!;
}

export const REVIEW_RESULT_SECTIONS = ['Ошибка при выборе кошелька', 'Результат попытки'] as const;
