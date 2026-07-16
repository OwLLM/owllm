// Generated from an audited inventory of the live React UI source.
// Columns: English, Simplified Chinese, Korean, Japanese, Arabic, Italian.
// Keep English as the canonical fallback when adding or revising UI copy.
export const UI_CATALOG = [
  [
    "__custom__",
    "__custom__",
    "__custom__",
    "__custom__",
    "__custom__",
    "__custom__"
  ],
  [
    "- {0} (critic): mandatory reviewer for architecture decisions, MCP/security boundaries, runtime/bootstrap changes, workflow topology, and any user request that mentions \"critic\" or \"critical thinker\". Use @{1}: <question or plan to review>.",
    "- {0}（评论者）：负责架构决策、MCP/安全边界、运行时/引导程序变更、工作流拓扑以及任何提到“评论者”或“批判性思考者”的用户请求的强制审查者。使用 @{1}: <问题或要审查的计划>。",
    "- {0} (비평가): 아키텍처 결정, MCP/보안 경계, 런타임/부트스트랩 변경, 워크플로우 토폴로지, 그리고 '비평가' 또는 '비판적 사상가'를 언급하는 모든 사용자 요청에 대한 필수 검토자입니다. @{1}: <검토할 질문 또는 계획>을 사용하세요.",
    "- {0}（批評者）：アーキテクチャの決定、MCP/セキュリティ境界、ランタイム/ブートストラップの変更、ワークフロートポロジー、および「批評者」または「クリティカルシンカー」に言及するユーザーのリクエストに対する必須レビュアー。@{1} を使用：<質問またはレビュー計画>。",
    "- {0} (الناقد): المراجع الإلزامي لقرارات الهندسة المعمارية، حدود MCP/الأمان، تغييرات وقت التشغيل/التمهيد، هيكلية سير العمل، وأي طلب من المستخدم يذكر 'الناقد' أو 'المفكر النقدي'. استخدم @{1}: <سؤال أو خطة للمراجعة>.",
    "- {0} (critico): revisore obbligatorio per le decisioni architetturali, i confini MCP/security, le modifiche runtime/bootstrap, la topologia del flusso di lavoro e qualsiasi richiesta dell'utente che menzioni \"critico\" o \"pensatore critico\". Utilizza @{1}: <domanda o piano da revisionare>."
  ],
  [
    "- Follow-up batch...",
    "- 后续批次...",
    "- 후속 배치...",
    "- フォローアップのバッチ...",
    "- دفعة متابعة...",
    "- Lotto di follow-up..."
  ],
  [
    "- Optional or parked work...",
    "- 可选或暂存的工作...",
    "- 선택적 또는 보류된 작업...",
    "- 任意の作業または保留中の作業...",
    "- عمل اختياري أو متوقف...",
    "- Lavoro opzionale o parcheggiato..."
  ],
  [
    "- Ship the coherent first batch...",
    "- 发送连贯的第一批...",
    "- 일관된 첫 배치 배송...",
    "- 整合した最初のバッチを出荷...",
    "- شحن الدفعة الأولى المتسقة...",
    "- Spedisci il primo lotto coerente..."
  ],
  [
    "-<QUANT>.gguf",
    "-<QUANT>.gguf",
    "-<QUANT>.gguf",
    "-<QUANT>.gguf",
    "-<QUANT>.gguf",
    "-<QUANT>.gguf"
  ],
  [
    "-y @modelcontextprotocol/server-brave-search",
    "-y @modelcontextprotocol/server-brave-search",
    "-y @modelcontextprotocol/server-brave-search",
    "-y @modelcontextprotocol/server-brave-search",
    "-y @modelcontextprotocol/server-brave-search",
    "-y @modelcontextprotocol/server-brave-search"
  ],
  [
    "— agents currently see only built-in tools (read_file, shell, web_search…). This is also the quickest way to test whether an MCP tool is breaking agentic tool-calling: leave it off and re-run; if tools now fire, an MCP schema was the culprit.",
    "— 代理当前只能看到内置工具（read_file、shell、web_search…）。这也是测试 MCP 工具是否破坏代理工具调用的最快方法：关闭它并重新运行；如果工具现在可以触发，则 MCP 模式是罪魁祸首。",
    "— 에이전트는 현재 내장 도구(read_file, shell, web_search…)만 봅니다. 이것은 MCP 도구가 에이전트의 도구 호출을 깨뜨리는지 테스트하는 가장 빠른 방법이기도 합니다: 이를 끄고 다시 실행해 보세요; 도구가 이제 작동하면, MCP 스키마가 원인이었습니다.",
    "— エージェントは現在、組み込みツール（read_file、shell、web_search…）のみを使用できます。これは、MCPツールがエージェントのツール呼び出しを壊しているかどうかをテストする最も速い方法でもあります：ツールをオフにして再実行してください；もしツールが今動作するなら、MCPスキーマが原因です。",
    "— الوكلاء يرون حالياً الأدوات المدمجة فقط (قراءة_ملف، شل، بحث_على_الويب…). هذه أيضاً أسرع طريقة لاختبار ما إذا كانت أداة MCP تكسر استدعاء الأدوات من قبل الوكيل: اتركها مغلقة وأعد التشغيل؛ إذا انطلقت الأدوات الآن، فإن مخطط MCP كان السبب.",
    "— gli agenti vedono attualmente solo strumenti integrati (read_file, shell, web_search…). Questo è anche il modo più veloce per testare se uno strumento MCP sta interrompendo la chiamata a strumenti agentici: disattivalo e rilancia; se ora gli strumenti si attivano, uno schema MCP era il colpevole."
  ],
  [
    "— anti-pattern; do NOT do this unless the goal is impossible without it.",
    "— 反模式；除非目标在没有它的情况下无法实现，否则不要这么做。",
    "— 안티 패턴; 목표 달성이 불가능한 경우가 아니라면 절대 이렇게 하지 마세요.",
    "— アンチパターン；これを行うのは、それなしでは目標が不可能な場合のみにしてください。",
    "— نمط مضاد؛ لا تفعل هذا إلا إذا كان الهدف مستحيلاً من دونه.",
    "— anti-pattern; NON farlo a meno che l'obiettivo sia impossibile senza."
  ],
  [
    "— any project folder, e.g. a repo on GitHub",
    "— 任何项目文件夹，例如 GitHub 上的仓库",
    "— GitHub의 저장소와 같은 프로젝트 폴더",
    "— 任意のプロジェクトフォルダー、例：GitHub のリポジトリ",
    "— أي مجلد مشروع، على سبيل المثال، مستودع على GitHub",
    "— qualsiasi cartella di progetto, ad esempio un repo su GitHub"
  ],
  [
    "— approve it. When it finishes,",
    "— 批准它。当它完成时，",
    "— 승인하세요. 완료되면,",
    "— これを承認してください。終了したら、",
    "— اعتمده. عندما ينتهي،",
    "— approvalo. Quando termina,"
  ],
  [
    "— check the team name and try again.",
    "— 检查团队名称并重试。",
    "— 팀 이름을 확인하고 다시 시도하세요.",
    "— チーム名を確認して、再度試してください。",
    "— تحقق من اسم الفريق وحاول مرة أخرى.",
    "— controlla il nome del team e riprova."
  ],
  [
    "— copy this code and paste it there:",
    "— 复制此代码并粘贴到那里：",
    "— 이 코드를 복사해서 거기에 붙여넣으세요:",
    "— このコードをコピーしてそこに貼り付けてください：",
    "— انسخ هذا الكود والصقه هناك:",
    "— copia questo codice e incollalo lì:"
  ],
  [
    "— dir to commit for the release",
    "— 提交发布的目录",
    "— 릴리스를 위해 커밋할 디렉토리",
    "— リリース用にコミットするディレクトリ",
    "— الدليل للالتزام بالإصدار",
    "— directory da commettere per la release"
  ],
  [
    "— discovered on your account (",
    "— 在你的账号上发现（",
    "— 귀하의 계정에서 발견됨 (",
    "— あなたのアカウントで発見されました (",
    "— تم اكتشافه في حسابك (",
    "— scoperto sul tuo account ("
  ],
  [
    "— editable, seeded by your pick",
    "— 可编辑，由你选择的内容初始化",
    "— 편집 가능하며, 귀하의 선택으로 시드됨",
    "— 編集可能で、あなたの選択により初期設定されています",
    "— قابل للتعديل، تم تهيئته باختيارك",
    "— modificabile, inserito dalla tua scelta"
  ],
  [
    "— GitHub repo releases publish TO (may differ from origin)",
    "— GitHub 仓库发布到（可能与源不同）",
    "— GitHub 저장소 릴리즈에 게시됨 TO(원본과 다를 수 있음)",
    "— GitHubリポジトリのリリースは（オリジンとは異なる場合がある）TOに公開されます",
    "— إصدارات مستودع GitHub تُنشر إلى (قد تختلف عن الأصل)",
    "— Pubblicazioni dei rilasci del repository GitHub SU (può differire dall'origine)"
  ],
  [
    "— hard requirement; the team should refuse the goal if it can't comply.",
    "— 硬性要求；如果团队无法遵守，应拒绝该目标。",
    "— 강제 요구 사항; 팀은 준수할 수 없으면 목표를 거부해야 함.",
    "— 厳格な要件; チームは従えない場合、目標を拒否するべきです。",
    "— متطلب صارم؛ يجب على الفريق رفض الهدف إذا لم يكن بالإمكان الالتزام به.",
    "— requisito rigido; il team dovrebbe rifiutare l'obiettivo se non può rispettarlo."
  ],
  [
    "— isolated agents are authenticated.",
    "— 独立代理已通过认证。",
    "— 격리된 에이전트가 인증됨.",
    "— 分離されたエージェントは認証されています。",
    "— الوكلاء المعزولون مُوثقون.",
    "— gli agenti isolati sono autenticati."
  ],
  [
    "— it's faster and uses much less VRAM (best on modest GPUs), and supports the popular models (Llama, Mistral, Gemma, Qwen, Phi). Choose",
    "— 它更快且使用的显存少得多（在中等 GPU 上效果最佳），并支持流行模型（Llama、Mistral、Gemma、Qwen、Phi）。请选择",
    "— 더 빠르고 VRAM을 훨씬 적게 사용함(보통 GPU에서 최적), 인기 있는 모델(Llama, Mistral, Gemma, Qwen, Phi)을 지원함. 선택할 것",
    "— より高速で、VRAMの消費も大幅に少なく（控えめなGPUで最適）、人気のモデル（Llama, Mistral, Gemma, Qwen, Phi）をサポートします。選択してください",
    "— إنه أسرع ويستخدم ذاكرة VRAM أقل بكثير (الأفضل على بطاقات رسومية متواضعة)، ويدعم النماذج الشائعة (Llama، Mistral، Gemma، Qwen، Phi). اختر",
    "— è più veloce e utilizza molta meno VRAM (ottimo su GPU modeste) e supporta i modelli popolari (Llama, Mistral, Gemma, Qwen, Phi). Scegli"
  ],
  [
    "— just",
    "— 仅",
    "— 단지",
    "— ただ",
    "— فقط",
    "— solo"
  ],
  [
    "— MCP, Environment, Accounts, Logs.",
    "— MCP、环境、账户、日志。",
    "— MCP, 환경, 계정, 로그.",
    "— MCP、環境、アカウント、ログ。",
    "— MCP، البيئة، الحسابات، السجلات.",
    "— MCP, Ambiente, Account, Log."
  ],
  [
    "— no console popups. React talks to Rust via Tauri commands; there is no embedded Python HTTP server. Python is invoked one-shot only for the fine-tuning workflow and per-model virtualenv bootstrap.",
    "— 无控制台弹出。React 通过 Tauri 命令与 Rust 通信；没有嵌入的 Python HTTP 服务器。Python 仅在微调工作流程和每个模型的虚拟环境引导期间一次性调用。",
    "— 콘솔 팝업 없음. React는 Tauri 명령을 통해 Rust와 통신함; 내장된 Python HTTP 서버 없음. Python은 파인튜닝 워크플로우와 모델별 가상환경 부트스트랩 시 1회만 호출됨.",
    "— コンソールのポップアップなし。ReactはTauriコマンドを介してRustと通信します；埋め込みのPython HTTPサーバーはありません。Pythonはファインチューニングワークフローと各モデルのvirtualenvブートストラップのためだけに一度実行されます。",
    "— لا نوافذ منبثقة للوحة التحكم. يتحدث React إلى Rust عبر أوامر Tauri؛ لا يوجد خادم Python مدمج. يتم استدعاء Python مرة واحدة فقط لسير عمل الضبط الدقيق وإعداد virtualenv لكل نموذج.",
    "— nessun popup della console. React comunica con Rust tramite comandi Tauri; non c'è alcun server HTTP Python incorporato. Python è invocato una sola volta solo per il flusso di lavoro di fine-tuning e il bootstrap del virtualenv per ciascun modello."
  ],
  [
    "— none downloaded yet —",
    "— 尚未下载任何内容 —",
    "— 아직 다운로드된 것 없음 —",
    "— まだダウンロードされていません —",
    "— لم يتم تنزيل أي منها بعد —",
    "— nessuno scaricato ancora —"
  ],
  [
    "— on AMD it's",
    "— 在 AMD 上它是",
    "— AMD에서는",
    "— AMDでは",
    "— على AMD هو",
    "— su AMD è"
  ],
  [
    "— open the Train page and pick it as your dataset.",
    "— 打开训练页面，并将其作为你的数据集。",
    "— 학습(Train) 페이지를 열고 이를 데이터셋으로 선택합니다.",
    "— トレインページを開き、それをあなたのデータセットとして選択します。",
    "— افتح صفحة التدريب واخترها كمجموعة بياناتك.",
    "— apri la pagina Train e scegli questo come dataset."
  ],
  [
    "— port",
    "— 端口",
    "— 포트",
    "— ポート",
    "— المنفذ",
    "— porta"
  ],
  [
    "— proves a change is “done”",
    "— 证明更改已“完成”",
    "— 변경 사항이 \"완료됨\"을 증명합니다.",
    "— 変更が「完了」したことを証明します",
    "— يثبت أن التغيير \"تم\"",
    "— dimostra che una modifica è \"fatta\""
  ],
  [
    "— ready to send.",
    "— 准备发送。",
    "— 전송 준비 완료.",
    "— 送信の準備ができました。",
    "— جاهز للإرسال.",
    "— pronto per inviare."
  ],
  [
    "— reports go to the OwLLM team as GitHub issues, so you need a (free) GitHub account connected. One time, then it's one click from any PC you sign in on.",
    "— 报告会以 GitHub 问题的形式发送给 OwLLM 团队，因此你需要一个（免费的）GitHub 账户并连接。只需一次，然后在任何登录的电脑上一键即可。",
    "— 보고서는 GitHub 이슈로 OwLLM 팀에 제출되므로, 연결된 (무료) GitHub 계정이 필요합니다. 한 번만 설정하면 어떤 PC에서 로그인하든 한 번의 클릭으로 가능합니다.",
    "— レポートはGitHubの課題としてOwLLMチームに送られるので、（無料の）GitHubアカウントが接続されている必要があります。一度設定すれば、サインインする任意のPCからワンクリックで送信できます。",
    "— تقارير تذهب إلى فريق OwLLM كقضايا على GitHub، لذا تحتاج إلى حساب GitHub (مجاني) متصل. لمرة واحدة، ثم تصبح نقرة واحدة من أي جهاز كمبيوتر تقوم بتسجيل الدخول عليه.",
    "— i rapporti vanno al team OwLLM come problemi su GitHub, quindi è necessario un account GitHub (gratuito) collegato. Una volta, poi è un clic da qualsiasi PC su cui accedi."
  ],
  [
    "— same LAN, a Tailscale/WireGuard/VPN overlay (recommended for off-LAN, no setup here — your overlay IP is published automatically), a public host you set below, or a relay you host.",
    "— 相同局域网、Tailscale/WireGuard/VPN 覆盖（推荐用于局域网外，无需在此设置——你的覆盖 IP 会自动发布）、你在下方设置的公共主机，或者你自己托管的中继。",
    "— 동일 LAN, Tailscale/WireGuard/VPN 오버레이(권장, LAN 외부용, 여기서는 설정 없음 — 오버레이 IP가 자동으로 게시됨), 아래에 설정한 공용 호스트, 또는 직접 호스팅하는 중계 서버.",
    "— 同じLAN、Tailscale/WireGuard/VPNオーバーレイ（LAN外の場合に推奨、ここではセットアップ不要 — オーバーレイIPは自動的に公開されます）、下で設定したパブリックホスト、または自分でホストするリレー。",
    "— نفس الشبكة المحلية، تراكب Tailscale/WireGuard/VPN (موصى به للشبكات خارج LAN، لا حاجة للإعداد هنا — يتم نشر عنوان IP الخاص بالتراكب تلقائيًا)، مضيف عام تضبطه أدناه، أو مرسل تستضيفه.",
    "— stessa LAN, un overlay Tailscale/WireGuard/VPN (consigliato per off-LAN, nessuna configurazione qui — il tuo IP overlay viene pubblicato automaticamente), un host pubblico che configuri sotto, o un relay che ospiti."
  ],
  [
    "— Select a model —",
    "— 选择一个模型 —",
    "— 모델 선택 —",
    "— モデルを選択 —",
    "— اختر نموذجًا —",
    "— Seleziona un modello —"
  ],
  [
    "— soft hint; bias the plan toward this when there's a choice.",
    "— 软提示；在有选择时倾向于此计划。",
    "— 소프트 힌트; 선택지가 있을 때 계획을 이쪽으로 편향시킵니다.",
    "— ソフトヒント; 選択肢がある場合、この方向にプランを偏らせます。",
    "— تلميح ناعم؛ ميل الخطة نحو هذا عند وجود خيار.",
    "— suggerimento morbido; orienta il piano verso questo quando c'è una scelta."
  ],
  [
    "— start / stop a model.",
    "— 启动 / 停止一个模型。",
    "— 모델 시작 / 중지.",
    "— モデルを開始 / 停止",
    "— بدء / إيقاف نموذج.",
    "— avvia / ferma un modello."
  ],
  [
    "— take your chats, settings & agent teams to every device",
    "— 在每台设备上使用你的聊天、设置和代理团队",
    "— 모든 기기에서 채팅, 설정 및 에이전트 팀 이용하기",
    "— チャット、設定、エージェントチームをすべてのデバイスに持ち運ぶ",
    "— احضر محادثاتك وإعداداتك وفرق الوكلاء إلى كل جهاز",
    "— porta le tue chat, impostazioni e team di agenti su ogni dispositivo"
  ],
  [
    "— the bridge marks inbound mail as read as it processes it. For Gmail/Outlook, create an",
    "— 桥接在处理收件邮件时将其标记为已读。对于 Gmail/Outlook，请创建一个",
    "— 브리지는 수신 메일을 처리하면서 읽음으로 표시합니다. Gmail/Outlook의 경우, 생성하세요",
    "— ブリッジは、それを処理する際に受信メールを既読としてマークします。Gmail/Outlookの場合、作成します",
    "— يقوم الجسر بوضع علامة على البريد الوارد كمقروء أثناء معالجته. بالنسبة لـ Gmail/Outlook، أنشئ",
    "— il bridge contrassegna la posta in arrivo come letta mentre la elabora. Per Gmail/Outlook, crea un"
  ],
  [
    "— the file is duplicated inside the project and the sandbox stays intact. “Grant home” widens access to your whole user profile for this run only and resets automatically next run.",
    "— 文件在项目内部被复制，沙箱保持不变。“授权主目录”在此运行中扩大对整个用户配置文件的访问权限，并在下次运行时自动重置。",
    "— 파일은 프로젝트 안에서 복제되고 샌드박스는 그대로 유지됩니다. “홈 권한 부여”는 이번 실행에만 전체 사용자 프로필 접근을 확대하며 다음 실행 시 자동으로 재설정됩니다.",
    "— ファイルはプロジェクト内で複製され、サンドボックスはそのまま残ります。「ホームの権限を付与」は、この実行時のみユーザープロフィール全体へのアクセスを広げ、次回実行時に自動的にリセットされます。",
    "— يتم تكرار الملف داخل المشروع وتبقى منطقة الاختبار سليمة. \"منح الوصول الكامل\" يوسع الوصول إلى كامل ملف المستخدم لهذا التشغيل فقط ويتم إعادة تعيينه تلقائيًا عند التشغيل التالي.",
    "— il file viene duplicato all'interno del progetto e la sandbox rimane intatta. “Concedi accesso alla home” amplia l'accesso a tutto il profilo utente solo per questa esecuzione e viene reimpostato automaticamente alla successiva esecuzione."
  ],
  [
    "— the rules that travel with this repo (",
    "— 随此仓库一起传递的规则(",
    "— 이 레포와 함께 이동하는 규칙 (",
    "— このリポジトリに付属するルール(",
    "— القواعد التي تأتي مع هذا المستودع (",
    "— le regole che viaggiano con questo repository ("
  ],
  [
    "— unsupported",
    "— 不受支持",
    "— 지원되지 않음",
    "— サポートされていません",
    "— غير مدعوم",
    "— non supportato"
  ],
  [
    "— usually under",
    "— 通常在",
    "— 일반적으로 아래에",
    "— 通常は以下の場所に",
    "— عادة تحت",
    "— di solito sotto"
  ],
  [
    "— your chats & settings follow you across devices",
    "— 你的聊天记录和设置会在各设备间同步",
    "— 채팅과 설정이 기기 간에 따라옵니다",
    "— あなたのチャットと設定は、デバイス間で引き継がれます",
    "— محادثاتك وإعداداتك تتبعك عبر الأجهزة",
    "— le tue chat e impostazioni ti seguono su tutti i dispositivi"
  ],
  [
    ", …) are rewritten to OWLLM equivalents (",
    ", …) 在安装时被重写为 OWLLM 等价项(",
    ", …)는 설치 시 OWLLM에 해당하는 항목으로 다시 작성됩니다 (",
    ", …) はインストール時に OWLLM の同等物に書き換えられます(",
    "، …) يُعاد كتابتها إلى ما يعادلها في OWLLM (",
    ", …) vengono riscritte negli equivalenti OWLLM ("
  ],
  [
    ", …) on install.",
    ", …)。",
    ", …).",
    ", …)。",
    "، …) عند التثبيت.",
    ", …) all'installazione."
  ],
  [
    ", and under Event Subscriptions subscribe the bot to",
    "，并且在事件订阅下，将机器人订阅到",
    ", 그리고 이벤트 구독 아래에서 봇을 구독하도록 합니다 ",
    "、そしてイベントサブスクリプションの下でボットを購読します",
    "، وتحت اشتراكات الأحداث يتم الاشتراك للبوت في",
    ", e sotto Abbonamenti agli Eventi iscrivi il bot a"
  ],
  [
    ", not even Windows' own installer. It's a one-time toggle:",
    "，甚至不是 Windows 自己的安装程序。这是一次性的切换：",
    ", Windows 자체 설치 프로그램조차도 아닙니다. 이것은 한 번만 토글되는 기능입니다: ",
    "、Windows自身のインストーラーでもありません。一度だけの切り替えです：",
    "، ليس حتى مثبت ويندوز نفسه. إنه تبديل لمرة واحدة:",
    ", neanche l'installer di Windows stesso. È un interruttore una tantum:"
  ],
  [
    ", or",
    "，或者",
    ", 또는 ",
    "、または",
    "، أو",
    ", o"
  ],
  [
    ", or put it behind a",
    "，或者将其放在一个",
    ", 또는 그것을 뒤에 놓으세요",
    "、またはそれを背後に置きます",
    "، أو وضعه خلف",
    ", oppure mettilo dietro un"
  ],
  [
    ", then use",
    "后面，然后使用",
    ", 그런 다음 사용",
    "、それから使用する",
    "، ثم استخدم",
    ", quindi usa"
  ],
  [
    ", unsigned",
    "，未签名的",
    ", 서명되지 않음",
    "、未署名",
    "، غير موقع",
    ", non firmato"
  ],
  [
    "; ❌ rows won't fit, ⚠ rows are tight (will fit but no headroom for context).",
    "; ❌ 行不合适，⚠ 行很紧（能放下，但没有上下文余地）。",
    "; ❌ 행이 맞지 않음, ⚠ 행이 빡빡함(맞지만 문맥 여유 없음).",
    "； ❌ 行が収まらない、⚠ 行が窮屈（収まるがコンテキストの余裕なし）。",
    "; ❌ الصفوف لا تناسب، ⚠ الصفوف ضيقة (ستناسب ولكن لا مجال للسياق).",
    "; ❌ le righe non ci stanno, ⚠ le righe sono strette (ci staranno ma senza margine per il contesto)."
  ],
  [
    ": the pairs are written by the model you pick, from your sources. They can contain mistakes or hallucinations — review them below before training.",
    "：这些配对由你选择的模型根据你的来源编写。它们可能包含错误或幻觉——在训练前请在下面检查。",
    ": 쌍은 선택한 모델이 작성한 것으로, 출처에서 가져온 것입니다. 오류나 환상이 포함될 수 있으니, 학습 전에 아래에서 검토하세요.",
    "：ペアは選んだモデルがあなたのソースから書いたものです。間違いや幻覚が含まれている可能性があります — トレーニング前に下記を確認してください。",
    ": الأزواج مكتوبة بواسطة النموذج الذي تختاره، من مصادرِك. يمكن أن تحتوي على أخطاء أو أوهام — راجعها أدناه قبل التدريب.",
    ": le coppie sono scritte dal modello che scegli, dalle tue fonti. Possono contenere errori o invenzioni — rivedile qui sotto prima dell'addestramento."
  ],
  [
    ":<tool>",
    ":<工具>",
    ":<도구>",
    ":<ツール>",
    ":<أداة>",
    ":<strumento>"
  ],
  [
    "…and {0} more",
    "…以及 {0} 个更多",
    "…그리고 {0} 더",
    "…および {0} 件の追加",
    "…و {0} أخرى",
    "…e {0} in più"
  ],
  [
    "…or cert subject (CN)",
    "…或证书主题（CN）",
    "…또는 인증서 주체(CN)",
    "…または証明書のサブジェクト（CN）",
    "…أو موضوع الشهادة (CN)",
    "…o soggetto cert (CN)"
  ],
  [
    "· {0} uncommitted",
    "· {0} 个未提交",
    "· {0} 미커밋",
    "· {0} 件未コミット",
    "· {0} غير ملتزم بها",
    "· {0} non confermato"
  ],
  [
    "· allow-list active",
    "· 白名单已激活",
    "· 허용 목록 활성화",
    "· 許可リスト有効",
    "· قائمة السماح نشطة",
    "· lista consentiti attiva"
  ],
  [
    "· any sender",
    "· 任何发送者",
    "· 모든 발신자",
    "· 任意の送信者",
    "· أي مرسل",
    "· qualsiasi mittente"
  ],
  [
    "· API keys",
    "· API 密钥",
    "· API 키",
    "· API キー",
    "· مفاتيح API",
    "· chiavi API"
  ],
  [
    "· clean",
    "· 清理",
    "· 깨끗한",
    "· クリーン",
    "· نظيف",
    "· pulito"
  ],
  [
    "· click a node or arrow",
    "· 点击节点或箭头",
    "· 노드 또는 화살표를 클릭하세요",
    "· ノードや矢印をクリック",
    "· انقر على عقدة أو سهم",
    "· clicca su un nodo o una freccia"
  ],
  [
    "· facts sync across your PCs, worklog stays local",
    "· 事实在你的各个电脑上同步，工作日志保持本地",
    "· 사실은 PC 간 동기화되며, 작업 로그는 로컬에 유지됩니다",
    "· 事実はPC間で同期、作業ログはローカルに保持",
    "· تتزامن الحقائق عبر أجهزة الكمبيوتر الخاصة بك، ويظل سجل العمل محليًا",
    "· i fatti si sincronizzano tra i tuoi PC, il registro di lavoro rimane locale"
  ],
  [
    "· file",
    "· 文件",
    "· 파일",
    "· ファイル",
    "· ملف",
    "· file"
  ],
  [
    "· file {0}/{1}",
    "· 文件 {0}/{1}",
    "· 파일 {0}/{1}",
    "· ファイル {0}/{1}",
    "· ملف {0}/{1}",
    "· file {0}/{1}"
  ],
  [
    "· Green = fits your",
    "· 绿色 = 适合你的",
    "· 초록 = 당신에게 맞음",
    "· 緑 = あなたに合う",
    "· أخضر = يناسبك",
    "· Verde = adatta al tuo"
  ],
  [
    "· key",
    "· 密钥",
    "· 키",
    "· 鍵",
    "· مفتاح",
    "· chiave"
  ],
  [
    "· key stored — ready for the .cer",
    "· 密钥已存储 — 准备好 .cer",
    "· 키가 저장됨 — .cer 준비 완료",
    "· 鍵は保存済み — .cer用に準備完了",
    "· تم تخزين المفتاح — جاهز لـ .cer",
    "· chiave memorizzata — pronta per il .cer"
  ],
  [
    "· last:",
    "· 上次：",
    "· 마지막:",
    "· 最後:",
    "· آخر:",
    "· ultimo:"
  ],
  [
    "· open (any channel the bot is in)",
    "· 打开（机器人所在的任何频道）",
    "· 열기 (봇이 있는 모든 채널)",
    "· 開く（ボットがいる任意のチャンネル）",
    "· افتح (أي قناة يتواجد فيها الروبوت)",
    "· apri (qualsiasi canale in cui si trova il bot)"
  ],
  [
    "· open (any channel the bot sees)",
    "· 打开（机器人可见的任何频道）",
    "· 열기 (봇이 볼 수 있는 모든 채널)",
    "· 開く（ボットが見える任意のチャンネル）",
    "· افتح (أي قناة يراها الروبوت)",
    "· apri (qualsiasi canale che il bot vede)"
  ],
  [
    "· open (any chat)",
    "· 打开（任何聊天）",
    "· 열기 (모든 채팅)",
    "· 開く（任意のチャット）",
    "· افتح (أي محادثة)",
    "· apri (qualsiasi chat)"
  ],
  [
    "· Pick the quant that fits your GPU",
    "· 选择适合你 GPU 的量化",
    "· GPU에 맞는 양자를 선택하세요",
    "· あなたのGPUに合う量子化を選んでください",
    "· اختر الكوانت الذي يناسب معالج الرسوميات الخاص بك",
    "· Scegli il quant che si adatta alla tua GPU"
  ],
  [
    "· Press Stop to abort.",
    "· 按停止以中止。",
    "· 중지를 눌러 중단합니다.",
    "· 中止するには「停止」を押してください。",
    "· اضغط إيقاف للإلغاء.",
    "· Premi Stop per interrompere."
  ],
  [
    "· role '",
    "· 角色",
    "· 역할",
    "· 役割 '",
    "· الدور \"",
    "· ruolo \""
  ],
  [
    "· scanning…",
    "· 扫描中…",
    "· 스캔 중…",
    "· スキャン中…",
    "· أمسح...",
    "· scansione in corso…"
  ],
  [
    "· sender allow-list active",
    "· 发件人允许列表已启用",
    "· 발신자 허용 목록 활성",
    "· 送信者許可リストが有効",
    "· قائمة المسموح بالمرسل نشطة",
    "· lista di consentiti del mittente attiva"
  ],
  [
    "· SimplySign {0}",
    "· SimplySign {0}",
    "· SimplySign {0}",
    "· SimplySign {0}",
    "· توقيع بسيط {0}",
    "· SimplySign {0}"
  ],
  [
    "' tools",
    "' 工具",
    "' 도구",
    "' ツール",
    "' أدوات",
    "' strumenti"
  ],
  [
    "'{0}' is a built-in template — built-ins can't be deleted.",
    "'{0}' 是内置模板 — 内置模板不能被删除。",
    "'{0}'는 내장 템플릿입니다 — 내장된 항목은 삭제할 수 없습니다.",
    "'{0}' は組み込みテンプレートです — 組み込みは削除できません。",
    "'{0}' هو قالب مدمج — لا يمكن حذف القوالب المدمجة.",
    "'{0}' è un modello integrato — i modelli integrati non possono essere eliminati."
  ],
  [
    "'ArrowDown'). Use after browser_fill to submit a form or trigger a handler.",
    "'ArrowDown')。在 browser_fill 之后使用以提交表单或触发处理程序。",
    "'애로우다운'). browser_fill 후에 양식을 제출하거나 핸들러를 트리거할 때 사용하세요.",
    "'ArrowDown'）。フォームを送信するかハンドラーを起動するために browser_fill の後に使用します。",
    "'ArrowDown'). استخدم بعد ملء المتصفح لتقديم نموذج أو تفعيل معالج.",
    "'ArrowDown'). Usalo dopo browser_fill per inviare un modulo o attivare un handler."
  ],
  [
    "'Enter'), 'mouse' (move/click the emulated USB-HID mouse), 'boot_key' (tap a boot/BIOS key",
    "'Enter')，'mouse'（移动/点击模拟的 USB-HID 鼠标），'boot_key'（轻触启动/BIOS 键",
    "'Enter'), '마우스'(에뮬레이션된 USB-HID 마우스를 이동/클릭), 'boot_key'(부팅/BIOS 키를 탭하기)",
    "'Enter'）、'mouse' （エミュレートされた USB-HID マウスの移動/クリック）、'boot_key'（ブート/BIOS キーをタップ）",
    "'Enter'), 'mouse' (تحريك/نقر الفأرة المحاكية USB-HID)، 'boot_key' (اضغط مفتاح الإقلاع/BIوس)",
    "'Enter'), 'mouse' (muovi/clicca il mouse USB-HID emulato), 'boot_key' (premi un tasto di avvio/BIOS"
  ],
  [
    "'Let agents use remote devices' to be enabled on the Devices page.",
    "在“设备”页面上启用“让代理使用远程设备”。",
    "'에이전트가 원격 장치를 사용하도록 허용'을 장치 페이지에서 활성화합니다.",
    "「エージェントにリモートデバイスの使用を許可する」をデバイスページで有効にする。",
    "تمكين 'السماح للوكلاء باستخدام الأجهزة عن بُعد' في صفحة الأجهزة.",
    "'Permette agli agenti di usare dispositivi remoti' sarà abilitato nella pagina Dispositivi."
  ],
  [
    "'mount_iso' (attach a virtual USB ISO), 'power' (press the target's power/reset line).",
    "'mount_iso'（挂载虚拟 USB ISO），'power'（按目标的电源/重置线）。",
    "'mount_iso' (가상 USB ISO 연결), 'power' (대상 장치의 전원/재설정 라인 누르기).",
    "'mount_iso'（仮想USB ISOを接続）、'power'（ターゲットの電源／リセットラインを押す）。",
    "'mount_iso' (إرفاق ISO USB افتراضي)، 'power' (ضغط على خط الطاقة/إعادة الضبط للجهاز المستهدف).",
    "'mount_iso' (collegare un ISO USB virtuale), 'power' (premere la linea di alimentazione/reset del bersaglio)."
  ],
  [
    "’s GPU",
    "的 GPU",
    "의 GPU",
    "の GPU",
    "وحدة معالجة الرسوميات الخاصة",
    "GPU di"
  ],
  [
    "’s GPU (",
    "的 GPU (",
    "의 GPU (",
    "の GPU (",
    "وحدة معالجة الرسوميات الخاصة ب (",
    "GPU di ("
  ],
  [
    "'tablet'. Mobile presets resize the viewport to real phone/tablet dimensions",
    "'tablet'。移动设备预设将视口调整为真实手机/平板尺寸",
    "'tablet'. 모바일 프리셋은 뷰포트를 실제 전화/태블릿 크기로 조정합니다.",
    "'tablet'。モバイル用プリセットはビューポートを実際の電話／タブレットの寸法にリサイズする",
    "'جهاز لوحي'. الإعدادات المسبقة للهواتف المحمولة تعيد ضبط حجم عرض الشاشة إلى أبعاد الهاتف/الجهاز اللوحي الحقيقي",
    "'tablet'. I preset mobili ridimensionano il viewport alle dimensioni reali di telefono/tablet"
  ],
  [
    "'TEAM MEMORY — current shared knowledge' block (it may be empty on a new project).",
    "“团队记忆——当前共享知识”模块（在新项目中可能为空）。",
    "'팀 메모리 — 현재 공유 지식' 블록(새 프로젝트에서는 비어 있을 수 있음).",
    "'TEAM MEMORY — 現在の共有知識' ブロック（新しいプロジェクトでは空かもしれません）。",
    "كتلة 'ذاكرة الفريق — المعرفة المشتركة الحالية' (قد تكون فارغة في مشروع جديد).",
    "'MEMORIA DEL TEAM — conoscenza condivisa corrente' blocco (potrebbe essere vuoto in un nuovo progetto)."
  ],
  [
    "'true' = build+sign+latest.json but DO NOT publish (rehearsal).",
    "'true' = 构建+签名+latest.json 但不要发布（彩排）。",
    "'true' = build+sign+latest.json 하지만 게시하지 않음(리허설).",
    "'true' = build+sign+latest.json だが、公開はしない（リハーサル）。",
    "'true' = build+sign+latest.json ولكن لا تنشر (تجريبي).",
    "'vero' = build+sign+latest.json ma NON pubblicare (prove)."
  ],
  [
    "'true' = publish as a DRAFT for a human to flip public.",
    "'true' = 以草稿形式发布，由人工切换为公开。",
    "'true' = 사람이 공개로 전환할 수 있도록 DRAFT로 게시.",
    "'true' = 人間が公開を切り替えるためのドラフトとして公開。",
    "'true' = نشر كمسودة ليقوم إنسان بتحويلها إلى عام.",
    "'true' = pubblica come BOZZA per un umano da rendere pubblica."
  ],
  [
    "\" with the current filters.",
    "\"使用当前过滤器。\"",
    "현재 필터와 함께.",
    "現在のフィルターで。",
    "مع المرشحات الحالية.",
    "\" con i filtri attuali."
  ],
  [
    "\"button\"?: \"left\"|\"right\"|\"middle\", \"op\"?: \"move\"|\"click\"|\"down\"|\"up\"} —",
    "“按钮”?: “左”|“右”|“中间”, “操作”?: “移动”|“点击”|“按下”|“抬起”} —",
    "\"버튼\"?: \"왼쪽\"|\"오른쪽\"|\"가운데\", \"작업\"?: \"이동\"|\"클릭\"|\"누름\"|\"떼기\"} —",
    "\"button\"?: \"left\"|\"right\"|\"middle\", \"op\"?: \"move\"|\"click\"|\"down\"|\"up\"} —",
    "\"الزر\"؟: \"أيسر\"|\"أيمن\"|\"أوسط\", \"العملية\"؟: \"تحريك\"|\"نقر\"|\"ضغط\"|\"رفع\"",
    "\"pulsante\"?: \"sinistro\"|\"destro\"|\"centrale\", \"operazione\"?: \"muovi\"|\"clicca\"|\"premi\"|\"rilascia\"} —"
  ],
  [
    "\"transport\": \"ssh\" | \"http\" }. Provide EXACTLY one of auth.sshKeyPath or auth.token.",
    "\"传输\": \"ssh\" | \"http\" }. 确保只提供 auth.sshKeyPath 或 auth.token 的其中一个。",
    "\"transport\": \"ssh\" | \"http\" }. auth.sshKeyPath 또는 auth.token 중 정확히 하나를 제공하세요.",
    "\"transport\": \"ssh\" | \"http\" }。auth.sshKeyPath または auth.token のいずれかを正確に1つ提供する。",
    "'نقل': 'ssh' | 'http' }. قدم بالضبط واحد من auth.sshKeyPath أو auth.token.",
    "\"trasporto\": \"ssh\" | \"http\" }. Fornisci ESATTAMENTE uno di auth.sshKeyPath o auth.token."
  ],
  [
    "({0} changed)",
    "({0} 已更改)",
    "({0} 변경됨)",
    "({0} 変更)",
    "({0} تم التغيير)",
    "({0} modificato)"
  ],
  [
    "({0} GB)",
    "({0} GB)",
    "({0} GB)",
    "({0} GB)",
    "({0} جيجابايت)",
    "({0} GB)"
  ],
  [
    "(cheap, one function each) and shown read-only in the Inspector. Per-agent tool grants beyond the role are a project-level setting on the Agents page.",
    "（便宜，每个函数一个）并在检查器中只读显示。每个代理工具超出角色的权限是在“代理”页面上的项目级设置。",
    "(저렴, 각 기능 하나씩) 및 Inspector에서 읽기 전용으로 표시됨. 역할을 넘어선 에이전트 도구 권한은 Agents 페이지에서 프로젝트 수준 설정입니다.",
    "（安価で、各機能が1つずつ）およびインスペクターで読み取り専用として表示。エージェントごとのツール権限は、役割を超える場合、エージェントページのプロジェクトレベル設定です。",
    "(رخيص، وظيفة واحدة لكل منها) ومعروض للقراءة فقط في المفتش. تمنح صلاحيات الأداة لكل وكيل بالإضافة إلى الدور هي إعداد على مستوى المشروع في صفحة الوكلاء.",
    "(economico, una funzione ciascuno) e mostrato in sola lettura nell'Inspector. I permessi degli strumenti per agente oltre al ruolo sono un'impostazione a livello di progetto nella pagina Agenti."
  ],
  [
    "(current page)",
    "（当前页面）",
    "(현재 페이지)",
    "（現在のページ）",
    "(الصفحة الحالية)",
    "(pagina corrente)"
  ],
  [
    "(detached)",
    "（分离）",
    "(분리됨)",
    "（切り離し）",
    "(منفصل)",
    "(staccato)"
  ],
  [
    "(empty = any) alice@x.com, bob@y.com",
    "(空 = 任意) alice@x.com, bob@y.com",
    "(빈칸 = 모든) alice@x.com, bob@y.com",
    "（空欄 = すべて）alice@x.com、bob@y.com",
    "(فارغ = أي) alice@x.com, bob@y.com",
    "(vuoto = qualsiasi) alice@x.com, bob@y.com"
  ],
  [
    "(empty = any) U0123…, U0456…",
    "(空 = 任意) U0123…, U0456…",
    "(비어 있음 = 아무거나) U0123…, U0456…",
    "(空欄 = 任意) U0123…, U0456…",
    "(فارغ = أي) U0123…، U0456…",
    "(vuoto = qualsiasi) U0123…, U0456…"
  ],
  [
    "(empty)",
    "(空)",
    "(빈칸)",
    "（空）",
    "(فارغ)",
    "(vuoto)"
  ],
  [
    "(engine not installed)",
    "(引擎未安装)",
    "(엔진이 설치되지 않음)",
    "（エンジン未インストール）",
    "(المحرك غير مثبت)",
    "(motore non installato)"
  ],
  [
    "(env)",
    "(环境)",
    "(환경)",
    "（環境）",
    "(البيئة)",
    "(env)"
  ],
  [
    "(its members)",
    "(其成员)",
    "(그 구성원들)",
    "（そのメンバー）",
    "(أعضاؤه)",
    "(i suoi membri)"
  ],
  [
    "(leave empty = any channel the bot is in) · C0123…, D0456…",
    "(留空 = 机器人所在的任何频道) · C0123…, D0456…",
    "(비워 두기 = 봇이 있는 아무 채널) · C0123…, D0456…",
    "(空欄のまま = ボットがいる任意のチャンネル) · C0123…, D0456…",
    "(اتركه فارغ = أي قناة يكون البوت فيها) · C0123…، D0456…",
    "(lasciare vuoto = qualsiasi canale in cui è il bot) · C0123…, D0456…"
  ],
  [
    "(leave empty = any channel) · 112233445566778899, …",
    "(留空 = 任意频道) · 112233445566778899, …",
    "(비워 두기 = 아무 채널) · 112233445566778899, …",
    "(空欄のまま = 任意のチャンネル) · 112233445566778899, …",
    "(اتركه فارغ = أي قناة) · 112233445566778899، …",
    "(lasciare vuoto = qualsiasi canale) · 112233445566778899, …"
  ],
  [
    "(leave empty = any chat allowed) · 123456789, 987654321",
    "(留空 = 允许的任何聊天) · 123456789, 987654321",
    "(비워 두기 = 허용된 아무 채팅) · 123456789, 987654321",
    "(空欄のまま = 許可されている任意のチャット) · 123456789, 987654321",
    "(اتركه فارغ = أي دردشة مسموح بها) · 123456789، 987654321",
    "(lasciare vuoto = qualsiasi chat consentita) · 123456789, 987654321"
  ],
  [
    "(links, buttons, inputs) with their index numbers. You act on elements BY INDEX",
    "(链接, 按钮, 输入) 带有其索引号。你按索引号操作元素",
    "(링크, 버튼, 입력)과 그들의 인덱스 번호. 인덱스로 요소를 조작합니다",
    "（リンク、ボタン、入力）とそのインデックス番号。要素をインデックスで操作します",
    "(الروابط، الأزرار، المدخلات) مع أرقام الفهرس الخاصة بها. أنت تتصرف على العناصر حسب الفهرس",
    "(collegamenti, pulsanti, input) con i loro numeri di indice. Agisci sugli elementi PER INDICE"
  ],
  [
    "(no active inference servers)",
    "(没有活动的推理服务器)",
    "(활성 추론 서버 없음)",
    "（アクティブな推論サーバーなし）",
    "(لا توجد خوادم استدلال نشطة)",
    "(nessun server di inferenza attivo)"
  ],
  [
    "(no body)",
    "(无正文)",
    "(본문 없음)",
    "（本文なし）",
    "(لا جسم)",
    "(nessun corpo)"
  ],
  [
    "(no description)",
    "(无描述)",
    "(설명 없음)",
    "（説明なし）",
    "(لا وصف)",
    "(nessuna descrizione)"
  ],
  [
    "(no digest yet)",
    "(尚无摘要)",
    "(아직 요약 없음)",
    "（まだダイジェストなし）",
    "(لا يوجد ملخص بعد)",
    "(nessun riepilogo ancora)"
  ],
  [
    "(no MCP servers running — start them on the MCP page)",
    "（没有运行中的 MCP 服务器——请在 MCP 页面启动它们）",
    "(MCP 서버가 실행 중이 아님 — MCP 페이지에서 시작하세요)",
    "（MCPサーバーが実行されていません — MCPページで起動してください）",
    "(لا توجد خوادم MCP قيد التشغيل — ابدأها في صفحة MCP)",
    "(nessun server MCP in esecuzione — avviali dalla pagina MCP)"
  ],
  [
    "(no messages yet)",
    "(尚无消息)",
    "(아직 메시지 없음)",
    "（まだメッセージなし）",
    "(لا توجد رسائل بعد)",
    "(nessun messaggio ancora)"
  ],
  [
    "(no model selected)",
    "(未选择模型)",
    "(모델 선택 안 됨)",
    "（モデル未選択）",
    "(لا يوجد نموذج محدد)",
    "(nessun modello selezionato)"
  ],
  [
    "(no model)",
    "(没有模型)",
    "(모델 없음)",
    "（モデルなし）",
    "(لا نموذج)",
    "(nessun modello)"
  ],
  [
    "(no other agents)",
    "(没有其他代理)",
    "(다른 에이전트 없음)",
    "（他のエージェントなし）",
    "(لا وكلاء آخرون)",
    "(nessun altro agente)"
  ],
  [
    "(no project open)",
    "(没有打开的项目)",
    "(열려 있는 프로젝트 없음)",
    "（プロジェクト未オープン）",
    "(لا يوجد مشروع مفتوح)",
    "(nessun progetto aperto)"
  ],
  [
    "(no project)",
    "(没有项目)",
    "(프로젝트 없음)",
    "（プロジェクトなし）",
    "(لا يوجد مشروع)",
    "(nessun progetto)"
  ],
  [
    "(no projects — + New)",
    "（没有项目——+ 新建）",
    "(프로젝트 없음 — + 새로 만들기)",
    "（プロジェクトがありません — + 新規）",
    "(no projects — + جديد)",
    "(nessun progetto — + Nuovo)"
  ],
  [
    "(no skill selected)",
    "(未选择技能)",
    "(선택된 기술 없음)",
    "（スキル未選択）",
    "(لا توجد مهارة محددة)",
    "(nessuna abilità selezionata)"
  ],
  [
    "(no stack trace)",
    "(没有堆栈跟踪)",
    "(스택 추적 없음)",
    "(スタックトレースなし)",
    "(لا يوجد أثر للتتبع)",
    "(nessuna traccia dello stack)"
  ],
  [
    "(no templates available)",
    "(没有可用模板)",
    "(사용 가능한 템플릿 없음)",
    "(利用可能なテンプレートなし)",
    "(لا توجد قوالب متاحة)",
    "(nessun modello disponibile)"
  ],
  [
    "(no user)",
    "(没有用户)",
    "(사용자 없음)",
    "(ユーザーなし)",
    "(لا يوجد مستخدم)",
    "(nessun utente)"
  ],
  [
    "(no username)",
    "(没有用户名)",
    "(사용자 이름 없음)",
    "(ユーザー名なし)",
    "(لا يوجد اسم مستخدم)",
    "(nessun nome utente)"
  ],
  [
    "(not Window). Off = record the whole screen.",
    "(不是窗口)。关闭 = 录制整个屏幕。",
    "(창 아님). Off = 전체 화면 기록.",
    "(Windowではありません)。オフ = 画面全体を記録。",
    "(ليس نافذة). إيقاف = تسجيل الشاشة كاملة.",
    "(non Finestra). Off = registra l'intero schermo."
  ],
  [
    "(nothing to commit)",
    "(无可提交内容)",
    "(커밋할 것 없음)",
    "(コミットするものなし)",
    "(لا شيء للالتزام به)",
    "(niente da confermare)"
  ],
  [
    "(or a team's Workbench) and tick it. At runtime the agent loads these instructions only when a task needs them.",
    "(或团队的工作台)并勾选它。在运行时，代理仅在任务需要时加载这些指令。",
    "(또는 팀의 워크벤치)에서 체크합니다. 실행 시 에이전트는 작업이 필요할 때만 이러한 지침을 로드합니다.",
    "(またはチームのWorkbench)をチェックします。ランタイム時に、エージェントはタスクが必要なときにのみこれらの指示を読み込みます。",
    "(أو ورشة فريق) وضع علامة عليه. عند التشغيل، يقوم الوكيل بتحميل هذه التعليمات فقط عندما يحتاجها مهمة.",
    "(o la Workbench di un team) e spuntalo. In fase di esecuzione l'agente carica queste istruzioni solo quando un compito ne ha bisogno."
  ],
  [
    "(pick a model)",
    "(选择一个模型)",
    "(모델 선택)",
    "（モデルを選択）",
    "(اختر نموذجًا)",
    "(scegli un modello)"
  ],
  [
    "(port-forward / DDNS / Tailscale MagicDNS host:port)",
    "(端口转发 / DDNS / Tailscale MagicDNS 主机:端口)",
    "(포트 포워딩 / DDNS / Tailscale MagicDNS 호스트:포트)",
    "(ポートフォワード / DDNS / Tailscale MagicDNS ホスト:ポート)",
    "(إعادة توجيه المنفذ / DDNS / Tailscale MagicDNS المضيف:المنفذ)",
    "(port-forward / DDNS / Tailscale MagicDNS host:port)"
  ],
  [
    "(Port:",
    "(端口:",
    "(포트:",
    "(ポート:",
    "(المنفذ:",
    "(Porta:"
  ],
  [
    "(pure-NAT fallback — both devices dial out; it only sees ciphertext)",
    "(纯 NAT 回退 — 两个设备都拨出；它只能看到密文)",
    "(순수 NAT 폴백 — 두 장치 모두 발신; 암호문만 볼 수 있음)",
    "（ピュアNATフォールバック — 両方のデバイスが発信する；暗号文しか見えない）",
    "(استرجاع NAT النقي — كلا الجهازين يتصلان؛ هو يرى النص المشفر فقط)",
    "(ripiego pure-NAT — entrambi i dispositivi eseguono la chiamata in uscita; vede solo il testo cifrato)"
  ],
  [
    "(screenshot attached 📸)",
    "(截图已附 📸)",
    "(스크린샷 첨부 📸)",
    "（スクリーンショット添付 📸）",
    "(تم إرفاق لقطة شاشة 📸)",
    "(screenshot allegato 📸)"
  ],
  [
    "(Tailscale, WireGuard). Never port-forward it to the internet. Scope your Windows Firewall rule to this port + the agent's IP.",
    "(Tailscale, WireGuard)。绝不要将其端口转发到互联网。将你的 Windows 防火墙规则限制到此端口 + 代理的 IP。",
    "(Tailscale, WireGuard). 절대 인터넷으로 포트 포워딩하지 마세요. Windows 방화벽 규칙을 이 포트 + 에이전트의 IP로 범위를 지정하세요.",
    "(Tailscale、WireGuard)。決してインターネットにポートフォワードしないでください。Windowsファイアウォールのルールをこのポート＋エージェントのIPに限定してください。",
    "(Tailscale، WireGuard). لا تقم أبدًا بإعادة توجيه المنفذ إلى الإنترنت. قم بتحديد قاعدة جدار حماية Windows الخاص بك لهذا المنفذ + عنوان IP الخاص بالوكيل. ",
    "(Tailscale, WireGuard). Non inoltrarlo mai su Internet. Limita la regola del tuo Windows Firewall a questa porta + l'IP dell'agente."
  ],
  [
    "(then stay resident), or immediately if you click",
    "(然后保持常驻)，或者如果你点击则立即执行",
    "(그런 다음 상주 상태를 유지), 또는 클릭하면 즉시",
    "（その後、常駐）、またはクリックした場合は即座に",
    "(ثم ابق مقيماً)، أو فورًا إذا نقرت",
    "(poi resta residente), o immediatamente se clicchi"
  ],
  [
    "(this PC)",
    "(此电脑)",
    "(이 PC)",
    "（このPC）",
    "(هذا الكمبيوتر)",
    "(questo PC)"
  ],
  [
    "(under Fine Tuning) — browse discovered GGUFs.",
    "(在微调下) — 浏览发现的 GGUF 文件。",
    "(파인 튜닝 중) — 발견된 GGUF를 탐색합니다.",
    "（ファインチューニングの下）— 発見されたGGUFを閲覧します。",
    "(تحت الضبط الدقيق) — تصفح GGUFs المكتشفة.",
    "(sotto Fine Tuning) — sfoglia i GGUF scoperti."
  ],
  [
    "(under Fine Tuning) — talk to the running model.",
    "(在微调下) — 与正在运行的模型对话。",
    "(파인 튜닝 중) — 실행 중인 모델과 대화합니다.",
    "（ファインチューニングの下）— 実行中のモデルと話します。",
    "(تحت الضبط الدقيق) — تحدث إلى النموذج الجاري تشغيله.",
    "(sotto Fine Tuning) — parla con il modello in esecuzione."
  ],
  [
    "(unset)",
    "(未设置)",
    "(해제)",
    "（未設定）",
    "(غير مضبوط)",
    "(non impostato)"
  ],
  [
    "(use project roster",
    "(使用项目名册",
    "(프로젝트 명단 사용",
    "（プロジェクト名簿を使用",
    "(استخدم قائمة المشروع",
    "(utilizza l'elenco progetti"
  ],
  [
    "(VM)",
    "(VM)",
    "(VM)",
    "（VM）",
    "(VM)",
    "(VM)"
  ],
  [
    ") — fit colours disabled. Confirm your selected GPU on the main page header / Advanced › Hardware tab.",
    ") — 拟合颜色已禁用。请在主页标题 / 高级 › 硬件选项卡上确认您选择的 GPU。",
    ") — 색상 맞춤이 비활성화되었습니다. 선택한 GPU를 메인 페이지 헤더 / 고급 › 하드웨어 탭에서 확인하세요.",
    "）— 色の適合は無効です。メインページのヘッダー／Advanced › Hardwareタブで選択したGPUを確認してください。",
    ") — الألوان المناسبة معطلة. تحقق من وحدة معالجة الرسوميات التي اخترتها في رأس الصفحة الرئيسية / المتقدم › تبويب الأجهزة.",
    ") — adattamento dei colori disabilitato. Conferma la GPU selezionata nell'intestazione della pagina principale / scheda Avanzate › Hardware."
  ],
  [
    ") — orchestrator, specialists, and the critic all see them on every turn.",
    ") — 协调器、专家和评论家在每次轮次中都会看到它们。",
    ") — 오케스트레이터, 전문가, 평론가가 모든 턴에서 이를 볼 수 있습니다.",
    "）— オーケストレーター、スペシャリスト、および批評家は、毎ターンそれらをすべて見ます。",
    ") — يراهم المنسق، والمتخصصون، والناقد في كل دورة.",
    ") — orchestratore, specialisti e critico li vedono tutti a ogni turno."
  ],
  [
    ") and paste the code. Waiting for you…",
    ") 并粘贴代码。等你……",
    ") 그리고 코드를 붙여넣으세요. 기다리고 있습니다…",
    "）そしてコードを貼り付けます。あなたを待っています…",
    ") والصق الكود. في انتظارك…",
    ") e incolla il codice. In attesa di te…"
  ],
  [
    ") silence a single one, and every MCP schema is auto-sanitized before it reaches the model so one bad schema can't break tool-calling. Config persisted to",
    ") 静默其中一个，每个 MCP 架构在到达模型之前都会自动清理，因此一个坏的架构不会破坏工具调用。配置已保存至",
    ") 하나만 음소거하면 모든 MCP 스키마가 모델에 도달하기 전에 자동으로 정리되므로 하나의 잘못된 스키마가 도구 호출을 망칠 수 없습니다. 구성은 다음에 저장됨",
    ") 一つでも無効にすると、すべてのMCPスキーマはモデルに到達する前に自動的にサニタイズされるため、1つの不良スキーマがツール呼び出しを壊すことはありません。設定は次に保存されます",
    ") صمّت واحداً فقط، وكل مخطط MCP يتم تنظيفه تلقائياً قبل وصوله إلى النموذج حتى لا يتمكن أي مخطط سيئ من كسر استدعاء الأدوات. تم حفظ التكوين إلى",
    ") silenzia uno solo, e ogni schema MCP viene auto-sanitizzato prima di raggiungere il modello, così un solo schema difettoso non può rompere le chiamate agli strumenti. Config salvata in"
  ],
  [
    "[REMEMBER key=<optional-stable-id> tags=<optional,comma,tags>] <the fact>",
    "[REMEMBER key=<optional-stable-id> tags=<optional,comma,tags>] 这个事实",
    "[REMEMBER key=<optional-stable-id> tags=<optional,comma,tags>] <사실>",
    "[REMEMBER key=<optional-stable-id> tags=<optional,comma,tags>] <事実>",
    "[تذكر key=<optional-stable-id> tags=<optional,comma,tags>] <الحقيقة>",
    "[RICORDA key=<optional-stable-id> tags=<optional,comma,tags>] <il fatto>"
  ],
  [
    "[REMEMBER key=build_command tags=ci] Build with `npm run build` at the repo root.",
    "[REMEMBER key=build_command tags=ci] 在仓库根目录使用 `npm run build` 构建。",
    "[REMEMBER key=build_command tags=ci] 저장소 루트에서 `npm run build`로 빌드합니다.",
    "[REMEMBER key=build_command tags=ci] リポジトリのルートで `npm run build` を実行してビルドします。",
    "[REMEMBER key=build_command tags=ci] ابنِ باستخدام `npm run build` في جذر المستودع.",
    "[REMEMBER key=build_command tags=ci] Compila con `npm run build` nella root del repository."
  ],
  [
    "[REMEMBER] The auth flow lives in src/auth/session.ts and issues JWTs.",
    "[REMEMBER] 身份验证流程在 src/auth/session.ts 中，并颁发 JWT。",
    "[REMEMBER] 인증 흐름은 src/auth/session.ts에 있으며 JWT를 발급합니다.",
    "[REMEMBER] 認証フローは src/auth/session.ts にあり、JWT を発行します。",
    "[REMEMBER] تدفق المصادقة موجود في src/auth/session.ts ويصدر JWTs.",
    "[REMEMBER] Il flusso di autenticazione si trova in src/auth/session.ts ed emette JWT."
  ],
  [
    "{ \"host\": string, \"port\"?: number, \"auth\": { \"sshKeyPath\"?: string, \"token\"?: string },",
    "{ \"host\": string, \"port\"?: number, \"auth\": { \"sshKeyPath\"?: string, \"token\"?: string },",
    "{ \"host\": string, \"port\"?: number, \"auth\": { \"sshKeyPath\"?: string, \"token\"?: string },",
    "{ \"host\": string, \"port\"?: number, \"auth\": { \"sshKeyPath\"?: string, \"token\"?: string },",
    "{ \"host\": \"string\", \"port\"?: \"number\", \"auth\": { \"sshKeyPath\"?: \"string\", \"token\"?: \"string\" },",
    "{ \"host\": string, \"port\"?: number, \"auth\": { \"sshKeyPath\"?: string, \"token\"?: string },"
  ],
  [
    "{\"EXTRA_VAR\": \"value\"}",
    "{\"EXTRA_VAR\": \"value\"}",
    "{\"EXTRA_VAR\": \"value\"}",
    "{\"EXTRA_VAR\": \"value\"}",
    "{\"EXTRA_VAR\": \"value\"}",
    "{\"EXTRA_VAR\": \"value\"}"
  ],
  [
    "{0} — {1} saved logins",
    "{0} — {1} 个已保存的登录",
    "{0} — {1} 저장된 로그인",
    "{0} — {1} 件の保存済みログイン",
    "{0} — {1} تسجيلات دخول محفوظة",
    "{0} — {1} accessi salvati"
  ],
  [
    "{0} — captured view: {1}",
    "{0} — 捕获的视图：{1}",
    "{0} — 캡처된 뷰: {1}",
    "{0} — キャプチャされたビュー: {1}",
    "{0} — العرض الذي تم التقاطه: {1}",
    "{0} — vista catturata: {1}"
  ],
  [
    "{0} — environment log",
    "{0} — 环境日志",
    "{0} — 환경 로그",
    "{0} — 環境ログ",
    "{0} — سجل البيئة",
    "{0} — registro dell'ambiente"
  ],
  [
    "{0} — team run in progress",
    "{0} — 团队运行中",
    "{0} — 팀 실행 진행 중",
    "{0} — チーム実行中",
    "{0} — تشغيل الفريق جارٍ",
    "{0} — esecuzione del team in corso"
  ],
  [
    "{0} — unlocks at {1} XP",
    "{0} — {1} XP 解锁",
    "{0} — {1} 경험치에서 잠금 해제",
    "{0} — {1} XP でアンロック",
    "{0} — يفتح عند {1} نقطة خبرة",
    "{0} — si sblocca a {1} XP"
  ],
  [
    "{0} (local — private, free)",
    "{0}（本地 — 私有，免费）",
    "{0} (로컬 — 개인, 무료)",
    "{0} (ローカル — プライベート、無料)",
    "{0} (محلي — خاص، مجاني)",
    "{0} (locale — privato, gratuito)"
  ],
  [
    "{0} (local)",
    "{0}（本地）",
    "{0} (로컬)",
    "{0}（ローカル）",
    "{0} (محلي)",
    "{0} (locale)"
  ],
  [
    "{0} {1} · {2} ms",
    "{0} {1} · {2} 毫秒",
    "{0} {1} · {2} ms",
    "{0} {1} · {2} ミリ秒",
    "{0} {1} · {2} ملثانية",
    "{0} {1} · {2} ms"
  ],
  [
    "{0} available across running servers",
    "{0} 可在所有运行服务器上使用",
    "{0} 실행 중인 서버에서 사용 가능",
    "{0} が実行中のサーバー全体で利用可能",
    "{0} متاح عبر الخوادم الجارية",
    "{0} disponibile su tutti i server in esecuzione"
  ],
  [
    "{0} base · {1} temp",
    "{0} 基础 · {1} 温度",
    "{0} 기본 · {1} 임시",
    "{0} ベース · {1} 温度",
    "{0} قاعدة · {1} حرارة",
    "{0} base · {1} temp"
  ],
  [
    "{0} CLI needs Node.js, which isn't installed yet. Install the bundled Node.js + uv toolchain now? (~47 MB, one-time download) After it finishes I'll retry the {1} CLI install automatically.",
    "{0} CLI 需要 Node.js，但它尚未安装。现在安装捆绑的 Node.js + uv 工具链吗？（约 47 MB，一次性下载）安装完成后，我会自动重新尝试安装 {1} CLI。",
    "{0} CLI에는 아직 설치되지 않은 Node.js가 필요합니다. 번들에 포함된 Node.js + uv 툴체인을 지금 설치하시겠습니까? (~47 MB, 한 번만 다운로드) 설치가 완료되면 {1} CLI 설치를 자동으로 다시 시도합니다.",
    "{0} CLIはNode.jsが必要ですが、まだインストールされていません。バンドルされているNode.js + uvツールチェーンを今すぐインストールしますか？（約47 MB、ワンタイムダウンロード）完了後、{1} CLIのインストールを自動的に再試行します。",
    "تحتاج واجهة الأوامر {0} إلى Node.js، والذي لم يتم تثبيته بعد. هل ترغب في تثبيت Node.js + uv المضمَّن الآن؟ (~47 ميغابايت، تحميل لمرة واحدة) بعد الانتهاء، سأعيد محاولة تثبيت واجهة الأوامر {1} تلقائيًا.",
    "{0} CLI necessita di Node.js, che non è ancora installato. Vuoi installare ora il toolchain Node.js + uv incluso? (~47 MB, download unico) Dopo il completamento riproverò automaticamente a installare il CLI {1}."
  ],
  [
    "{0} commit(s) ahead of upstream — Push sends them",
    "{0} 提交领先上游 — 推送将发送它们",
    "{0} 커밋이 업스트림보다 앞서 있음 — 푸시하면 전송됨",
    "{0} コミットがアップストリームより先行 — プッシュで送信",
    "{0} التزام(ات) متقدمة على المستودع الأصلي — الدفع يرسلها",
    "{0} commit avanti rispetto all'upstream — Push li invia"
  ],
  [
    "{0} commit(s) behind upstream",
    "{0} 提交落后上游 {0} 个",
    "업스트림보다 {0} 커밋 뒤처짐",
    "{0} コミットが上流より遅れています",
    "{0} التزام(ات) متأخر عن الفرع الرئيسي",
    "{0} commit indietro rispetto all'upstream"
  ],
  [
    "{0} done",
    "{0} 完成",
    "{0} 완료",
    "{0} 完了",
    "{0} تم",
    "{0} fatto"
  ],
  [
    "{0} GPU · {1} GB VRAM ·",
    "{0} GPU · {1} GB 显存 ·",
    "{0} GPU · {1} GB VRAM ·",
    "{0} GPU · {1} GB VRAM ·",
    "{0} وحدة معالجة الرسوميات · {1} جيجابايت ذاكرة فيديو ·",
    "{0} GPU · {1} GB VRAM ·"
  ],
  [
    "{0} issue{1}",
    "{0} 问题{1}",
    "{0} 이슈{1}",
    "{0} 問題{1}",
    "{0} مشكلة{1}",
    "{0} problema{1}"
  ],
  [
    "{0} message{1} in this run",
    "{0} 本次运行中的消息{1}",
    "이번 실행에서 {0} 메시지{1}",
    "この実行でのメッセージ数: {0}",
    "{0} رسالة{1} في هذا التشغيل",
    "{0} messaggio{1} in questa esecuzione"
  ],
  [
    "{0} project rule{1}",
    "{0} 项目规则{1}",
    "{0} 프로젝트 규칙{1}",
    "{0} プロジェクトルール{1}",
    "{0} قاعدة مشروع{1}",
    "{0} regola progetto{1}"
  ],
  [
    "{0} release ({1}){2}",
    "{0} 版本发布 ({1}){2}",
    "{0} 릴리스 ({1}){2}",
    "{0} リリース ({1}){2}",
    "{0} إصدار ({1}){2}",
    "{0} release ({1}){2}"
  ],
  [
    "{0} running",
    "{0} 运行中",
    "{0} 실행 중",
    "{0} 実行中",
    "{0} جارٍ",
    "{0} in esecuzione"
  ],
  [
    "{0} selected · {1}",
    "{0} 已选择 · {1}",
    "{0} 선택됨 · {1}",
    "{0} 選択済み · {1}",
    "{0} مختار · {1}",
    "{0} selezionato · {1}"
  ],
  [
    "{0} tokens · KV cache ≈ {1} GB (30B-class)",
    "{0} 令牌 · KV 缓存 ≈ {1} GB（30B 级）",
    "{0} 토큰 · KV 캐시 ≈ {1} GB (30B급)",
    "{0} トークン · KV キャッシュ ≈ {1} GB (30B クラス)",
    "{0} رموز · ذاكرة التخزين المؤقت KV ≈ {1} جيجابايت (فئة 30B)",
    "{0} token · Cache KV ≈ {1} GB (classe 30B)"
  ],
  [
    "{0} tools advertised to agents",
    "向代理宣传的 {0} 个工具",
    "에이전트에 광고된 도구 {0}",
    "エージェントに宣伝されたツールの数: {0}",
    "{0} أدوات معلن عنها للوكلاء",
    "{0} strumenti pubblicizzati agli agenti"
  ],
  [
    "{0} Tools run in: {1}",
    "{0} 个工具运行于：{1}",
    "{0} 도구 실행 위치: {1}",
    "ツールの実行場所: {0} : {1}",
    "{0} الأدوات تعمل في: {1}",
    "{0} Strumenti eseguiti in: {1}"
  ],
  [
    "{0} uncommitted change(s) — Commit captures them",
    "{0} 个未提交的更改 — 提交将保存它们",
    "{0} 미커밋 변경 사항 — 커밋하여 저장",
    "{0} 件の未コミットの変更 — コミットでそれらを記録します",
    "{0} تغيير(ات) غير ملتزم بها — الالتزام يلتقطها",
    "{0} modifica/i non impegnata/e — Commit la cattura"
  ],
  [
    "{0} web login{1}",
    "{0} 次网页登录{1}",
    "{0} 웹 로그인{1}",
    "{0} ウェブログイン{1}",
    "{0} تسجيل الدخول إلى الويب{1}",
    "{0} login web{1}"
  ],
  [
    "{0}_custom",
    "{0}_自定义",
    "{0}_사용자_지정",
    "{0}_カスタム",
    "{0}_مخصص",
    "{0}_personalizzato"
  ],
  [
    "{0}{1}🖼 {2} image{3}",
    "{0}{1}🖼 {2} 张图片{3}",
    "{0}{1}🖼 {2} 이미지{3}",
    "{0}{1}🖼 {2} 枚の画像{3}",
    "{0}{1}🖼 {2} صورة{3}",
    "{0}{1}🖼 {2} immagine{3}"
  ],
  [
    "@keyframes owllm-edge-flow { to { stroke-dashoffset: -22; } }",
    "@keyframes owllm-edge-flow { to { stroke-dashoffset: -22; } }",
    "@keyframes owllm-edge-flow { to { stroke-dashoffset: -22; } }",
    "@keyframes owllm-edge-flow { to { stroke-dashoffset: -22; } }",
    "@keyframes owllm-edge-flow { إلى { stroke-dashoffset: -22; } }",
    "@keyframes owllm-edge-flow { to { stroke-dashoffset: -22; } }"
  ],
  [
    "@keyframes owllm-spin { to { transform: rotate(360deg); } }",
    "@keyframes owllm-spin { to { transform: rotate(360deg); } }",
    "@keyframes owllm-spin { to { transform: rotate(360deg); } }",
    "@keyframes owllm-spin { to { transform: rotate(360deg); } }",
    "@keyframes owllm-spin { إلى { transform: rotate(360deg); } }",
    "@keyframes owllm-spin { to { transform: rotate(360deg); } }"
  ],
  [
    "@keyframes owllm-update-fade { from { opacity: 0; } to { opacity: 1; } } @keyframes owllm-update-pop { from { opacity: 0; transform: translateY(8px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }",
    "@keyframes owllm-update-fade { from { opacity: 0; } to { opacity: 1; } } @keyframes owllm-update-pop { from { opacity: 0; transform: translateY(8px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }",
    "@keyframes owllm-update-fade { from { opacity: 0; } to { opacity: 1; } } @keyframes owllm-update-pop { from { opacity: 0; transform: translateY(8px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }",
    "@keyframes owllm-update-fade { from { opacity: 0; } to { opacity: 1; } } @keyframes owllm-update-pop { from { opacity: 0; transform: translateY(8px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }",
    "@keyframes owllm-update-fade { من { opacity: 0; } إلى { opacity: 1; } } @keyframes owllm-update-pop { من { opacity: 0; transform: translateY(8px) scale(0.98); } إلى { opacity: 1; transform: translateY(0) scale(1); } }",
    "@keyframes owllm-update-fade { from { opacity: 0; } to { opacity: 1; } } @keyframes owllm-update-pop { from { opacity: 0; transform: translateY(8px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }"
  ],
  [
    "@keyframes owllm-watcher-in { from { opacity: 0; } to { opacity: 1; } }",
    "@keyframes owllm-watcher-in { from { opacity: 0; } to { opacity: 1; } }",
    "@keyframes owllm-watcher-in { from { opacity: 0; } to { opacity: 1; } }",
    "@keyframes owllm-watcher-in { from { opacity: 0; } to { opacity: 1; } }",
    "@keyframes owllm-watcher-in { من { opacity: 0; } إلى { opacity: 1; } }",
    "@keyframes owllm-watcher-in { from { opacity: 0; } to { opacity: 1; } }"
  ],
  [
    "@keyframes owllm-watcher-orbit { 0% { opacity: 0; transform: translate(-14px, 4px) scale(0.92); } 12% { opacity: 1; transform: translate(0, 0) scale(1); } 50% { opacity: 1; transform: translate(8px, -3px) scale(1); } 88% { opacity: 1; transform: translate(16px, 2px) scale(1); } 100% { opacity: 0; transform: translate(28px, 6px) scale(0.92); } }",
    "@keyframes owllm-watcher-orbit { 0% { opacity: 0; transform: translate(-14px, 4px) scale(0.92); } 12% { opacity: 1; transform: translate(0, 0) scale(1); } 50% { opacity: 1; transform: translate(8px, -3px) scale(1); } 88% { opacity: 1; transform: translate(16px, 2px) scale(1); } 100% { opacity: 0; transform: translate(28px, 6px) scale(0.92); } }",
    "@keyframes owllm-watcher-orbit { 0% { 불투명도: 0; 변형: 이동(-14px, 4px) 크기조정(0.92); } 12% { 불투명도: 1; 변형: 이동(0, 0) 크기조정(1); } 50% { 불투명도: 1; 변형: 이동(8px, -3px) 크기조정(1); } 88% { 불투명도: 1; 변형: 이동(16px, 2px) 크기조정(1); } 100% { 불투명도: 0; 변형: 이동(28px, 6px) 크기조정(0.92); } }",
    "@keyframes owllm-watcher-orbit { 0% { opacity: 0; transform: translate(-14px, 4px) scale(0.92); } 12% { opacity: 1; transform: translate(0, 0) scale(1); } 50% { opacity: 1; transform: translate(8px, -3px) scale(1); } 88% { opacity: 1; transform: translate(16px, 2px) scale(1); } 100% { opacity: 0; transform: translate(28px, 6px) scale(0.92); } }",
    "@keyframes owllm-watcher-orbit { 0% { opacity: 0; transform: translate(-14px, 4px) scale(0.92); } 12% { opacity: 1; transform: translate(0, 0) scale(1); } 50% { opacity: 1; transform: translate(8px, -3px) scale(1); } 88% { opacity: 1; transform: translate(16px, 2px) scale(1); } 100% { opacity: 0; transform: translate(28px, 6px) scale(0.92); } }",
    "@keyframes owllm-watcher-orbit { 0% { opacità: 0; trasformare: translate(-14px, 4px) scale(0.92); } 12% { opacità: 1; trasformare: translate(0, 0) scale(1); } 50% { opacità: 1; trasformare: translate(8px, -3px) scale(1); } 88% { opacità: 1; trasformare: translate(16px, 2px) scale(1); } 100% { opacità: 0; trasformare: translate(28px, 6px) scale(0.92); } }"
  ],
  [
    "@keyframes owllm-watcher-orbit { 0% { opacity: 0; transform: translate(-18px, 6px) scale(0.92); } 12% { opacity: 1; transform: translate(0, 0) scale(1); } 50% { opacity: 1; transform: translate(10px, -4px) scale(1); } 88% { opacity: 1; transform: translate(20px, 2px) scale(1); } 100% { opacity: 0; transform: translate(34px, 8px) scale(0.92); } }",
    "@keyframes owllm-watcher-orbit { 0% { opacity: 0; transform: translate(-18px, 6px) scale(0.92); } 12% { opacity: 1; transform: translate(0, 0) scale(1); } 50% { opacity: 1; transform: translate(10px, -4px) scale(1); } 88% { opacity: 1; transform: translate(20px, 2px) scale(1); } 100% { opacity: 0; transform: translate(34px, 8px) scale(0.92); } }",
    "@keyframes owllm-watcher-orbit { 0% { 불투명도: 0; 변형: 이동(-18px, 6px) 크기조정(0.92); } 12% { 불투명도: 1; 변형: 이동(0, 0) 크기조정(1); } 50% { 불투명도: 1; 변형: 이동(10px, -4px) 크기조정(1); } 88% { 불투명도: 1; 변형: 이동(20px, 2px) 크기조정(1); } 100% { 불투명도: 0; 변형: 이동(34px, 8px) 크기조정(0.92); } }",
    "@keyframes owllm-watcher-orbit { 0% { opacity: 0; transform: translate(-18px, 6px) scale(0.92); } 12% { opacity: 1; transform: translate(0, 0) scale(1); } 50% { opacity: 1; transform: translate(10px, -4px) scale(1); } 88% { opacity: 1; transform: translate(20px, 2px) scale(1); } 100% { opacity: 0; transform: translate(34px, 8px) scale(0.92); } }",
    "@keyframes owllm-watcher-orbit { 0% { opacity: 0; transform: translate(-18px, 6px) scale(0.92); } 12% { opacity: 1; transform: translate(0, 0) scale(1); } 50% { opacity: 1; transform: translate(10px, -4px) scale(1); } 88% { opacity: 1; transform: translate(20px, 2px) scale(1); } 100% { opacity: 0; transform: translate(34px, 8px) scale(0.92); } }",
    "@keyframes owllm-watcher-orbit { 0% { opacità: 0; trasformare: translate(-18px, 6px) scale(0.92); } 12% { opacità: 1; trasformare: translate(0, 0) scale(1); } 50% { opacità: 1; trasformare: translate(10px, -4px) scale(1); } 88% { opacità: 1; trasformare: translate(20px, 2px) scale(1); } 100% { opacità: 0; trasformare: translate(34px, 8px) scale(0.92); } }"
  ],
  [
    "@keyframes owllmBrowserFrameHue { to { filter: hue-rotate(360deg); } }",
    "@keyframes owllmBrowserFrameHue { to { filter: hue-rotate(360deg); } }",
    "@keyframes owllmBrowserFrameHue { to { filter: hue-rotate(360도); } }",
    "@keyframes owllmBrowserFrameHue { to { filter: hue-rotate(360deg); } }",
    "@keyframes owllmBrowserFrameHue { إلى { فلتر: تدوير-التدرج(360درجة); } }",
    "@keyframes owllmBrowserFrameHue { to { filter: hue-rotate(360deg); } }"
  ],
  [
    "@keyframes owllmIndeterminate { 0% { transform: translateX(-100%); } 100% { transform: translateX(400%); } }",
    "@keyframes owllmIndeterminate { 0% { transform: translateX(-100%); } 100% { transform: translateX(400%); } }",
    "@keyframes owllmIndeterminate { 0% { transform: translateX(-100%); } 100% { transform: translateX(400%); } }",
    "@keyframes owllmIndeterminate { 0% { transform: translateX(-100%); } 100% { transform: translateX(400%); } }",
    "@keyframes owllmIndeterminate { 0% { تحويل: ترحيلX(-100%); } 100% { تحويل: ترحيلX(400%); } }",
    "@keyframes owllmIndeterminate { 0% { transform: translateX(-100%); } 100% { transform: translateX(400%); } }"
  ],
  [
    "@keyframes owllmTutorialPulse { 0% { transform: scale(0.3); opacity: 0.95; } 100% { transform: scale(1.8); opacity: 0; } }",
    "@keyframes owllmTutorialPulse { 0% { transform: scale(0.3); opacity: 0.95; } 100% { transform: scale(1.8); opacity: 0; } }",
    "@keyframes owllmTutorialPulse { 0% { transform: scale(0.3); opacity: 0.95; } 100% { transform: scale(1.8); opacity: 0; } }",
    "@keyframes owllmTutorialPulse { 0% { transform: scale(0.3); opacity: 0.95; } 100% { transform: scale(1.8); opacity: 0; } }",
    "@keyframes owllmTutorialPulse { 0% { تحويل: مقياس(0.3); عتامة: 0.95; } 100% { تحويل: مقياس(1.8); عتامة: 0; } }",
    "@keyframes owllmTutorialPulse { 0% { transform: scale(0.3); opacity: 0.95; } 100% { transform: scale(1.8); opacity: 0; } }"
  ],
  [
    "@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }",
    "@keyframes pulse { 0%,100% { 透明度: 1 } 50% { 透明度: 0.35 } }",
    "@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }",
    "@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }",
    "@keyframes pulse { 0%,100% { عتامة: 1 } 50% { عتامة: 0.35 } }",
    "@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }"
  ],
  [
    "@property --owllm-aura-angle { syntax: \"<angle>\"; initial-value: 0deg; inherits: false; } @keyframes owllm-aura-spin { to { --owllm-aura-angle: 360deg; } }",
    "@property --owllm-aura-angle { 语法: \"<angle>\"; 初始值: 0deg; 继承: false; } @keyframes owllm-aura-spin { to { --owllm-aura-angle: 360deg; } }",
    "@property --owllm-aura-angle { syntax: \"<각도>\"; initial-value: 0도; inherits: false; } @keyframes owllm-aura-spin { to { --owllm-aura-angle: 360도; } }",
    "@property --owllm-aura-angle { syntax: \"<angle>\"; initial-value: 0deg; inherits: false; } @keyframes owllm-aura-spin { to { --owllm-aura-angle: 360deg; } }",
    "@property --owllm-aura-angle { الصياغة: \"<زاوية>\"; القيمة-الابتدائية: 0درجة; يرث: خطأ; } @keyframes owllm-aura-spin { إلى { --owllm-aura-angle: 360درجة; } }",
    "@property --owllm-aura-angle { syntax: \"<angle>\"; initial-value: 0deg; inherits: false; } @keyframes owllm-aura-spin { to { --owllm-aura-angle: 360deg; } }"
  ],
  [
    "* (any chars except /), ** (any depth incl. /), ? (one char).",
    "*（任意字符，除 / 之外）、**（任意深度，包括 /）、?（一个字符）。",
    "* (슬래시 제외 모든 문자), ** (모든 깊이의 문자 포함 /), ? (한 문자).",
    "* (「/」以外の任意の文字), ** (深さを含む任意の文字列), ? (1文字)。",
    "* (أي حروف ما عدا /), ** (أي عمق بما في ذلك /), ? (حرف واحد).",
    "* (qualsiasi carattere tranne /), ** (qualsiasi profondità incl. /), ? (un carattere)."
  ],
  [
    "&nbsp;",
    "&nbsp;",
    "&nbsp;",
    "&nbsp;",
    "&nbsp;",
    "&nbsp;"
  ],
  [
    "• Copy the API URL",
    "• 复制 API URL",
    "• API URL을 복사하세요",
    "• API URL をコピーする",
    "• انسخ عنوان URL لواجهة برمجة التطبيقات",
    "• Copia l'URL dell'API"
  ],
  [
    "• In Cursor / VS Code Continue, set Base URL to the copied URL",
    "• 在 Cursor / VS Code Continue 中，将基础 URL 设置为复制的 URL",
    "• Cursor / VS Code Continue에서 Base URL을 복사한 URL로 설정합니다.",
    "• Cursor / VS Code Continue で、Base URL をコピーした URL に設定します",
    "• في Cursor / VS Code Continue، قم بتعيين عنوان URL الأساسي إلى العنوان المنسوخ",
    "• In Cursor / VS Code Continua, imposta URL base sull'URL copiato"
  ],
  [
    "• Set API Key to any text (e.g. 'sk-local')",
    "• 将 API 密钥设置为任意文本（例如 'sk-local'）",
    "• API 키를 아무 텍스트로 설정합니다(예: 'sk-local').",
    "• API Key を任意のテキスト（例: 'sk-local'）に設定します",
    "• قم بتعيين مفتاح API إلى أي نص (مثل 'sk-local')",
    "• Imposta la chiave API su qualsiasi testo (ad esempio 'sk-local')"
  ],
  [
    "• Set Model to: {0}",
    "• 将模型设置为：{0}",
    "• 모델을 설정합니다: {0}",
    "• モデルを以下に設定します: {0}",
    "• قم بتعيين النموذج إلى: {0}",
    "• Imposta il modello su: {0}"
  ],
  [
    "• Start the LLM Server above",
    "• 启动上方的 LLM 服务器",
    "• 위의 LLM 서버를 시작합니다.",
    "• 上記で LLM サーバーを起動します",
    "• ابدأ خادم LLM أعلاه",
    "• Avvia il server LLM sopra"
  ],
  [
    "• unsaved",
    "• 未保存",
    "• 저장되지 않음",
    "• 保存されていません",
    "• غير محفوظ",
    "• non salvato"
  ],
  [
    "•••• stored — leave blank to keep",
    "•••• 已存储 — 留空以保留",
    "•••• 저장됨 — 유지하려면 비워둡니다.",
    "•••• 保存済み — 空白のままにして保持",
    "•••• مخزن — اتركه فارغًا للحفاظ عليه",
    "•••• memorizzato — lascia vuoto per mantenere"
  ],
  [
    "← Back",
    "← 返回",
    "← 뒤로",
    "← 戻る",
    "← رجوع",
    "← Indietro"
  ],
  [
    "← Change",
    "← 更改",
    "← 변경",
    "← 変更",
    "← تغيير",
    "← Modifica"
  ],
  [
    "← Forward to primary agent",
    "← 转发给主代理",
    "← 기본 에이전트로 전달",
    "← プライマリアージェントに転送",
    "← إعادة توجيه إلى الوكيل الأساسي",
    "← Inoltra all'agente principale"
  ],
  [
    "← Projects",
    "← 项目",
    "← 프로젝트",
    "← プロジェクト",
    "← المشاريع",
    "← Progetti"
  ],
  [
    "← Start",
    "← 开始",
    "← 시작",
    "← 開始",
    "← ابدأ",
    "← Avvia"
  ],
  [
    "← Teams",
    "← 团队",
    "← 팀",
    "← チーム",
    "← الفرق",
    "← Team"
  ],
  [
    "→ Forward to second agent",
    "→ 转发给第二代理",
    "→ 두 번째 에이전트로 전달",
    "→ セカンドエージェントに転送",
    "→ إعادة توجيه إلى الوكيل الثاني",
    "→ Inoltra al secondo agente"
  ],
  [
    "↓ Downloads",
    "↓ 下载",
    "↓ 다운로드",
    "↓ ダウンロード",
    "↓ التنزيلات",
    "↓ Download"
  ],
  [
    "↗ Create a token (repo scope)",
    "↗ 创建一个令牌（仓库范围）",
    "↗ 토큰 생성(저장소 범위)",
    "↗ トークンを作成（リポスコープ）",
    "↗ إنشاء رمز (نطاق المستودع)",
    "↗ Crea un token (ambito repo)"
  ],
  [
    "↗ Dispatches to",
    "↗ 派发到",
    "↗ 디스패치로",
    "↗ ディスパッチに送信",
    "↗ عمليات الإرسال إلى",
    "↗ Distribuzioni a"
  ],
  [
    "↘ Takes job from",
    "↘ 接手工作",
    "↘ 작업을 가져옵니다",
    "↘ 仕事を取得する",
    "↘ يأخذ وظيفة من",
    "↘ Prende lavoro da"
  ],
  [
    "↳ Reference in chat",
    "↳ 聊天中的引用",
    "↳ 채팅에서 참조",
    "↳ チャットで参照",
    "↳ إشارة في الدردشة",
    "↳ Riferimento in chat"
  ],
  [
    "↺ Reopen",
    "↺ 重新打开",
    "↺ 다시 열기",
    "↺ 再度開く",
    "↺ إعادة فتح",
    "↺ Riapri"
  ],
  [
    "↺ Reset to template",
    "↺ 重置为模板",
    "↺ 템플릿으로 재설정",
    "↺ テンプレートにリセット",
    "↺ إعادة التعيين إلى النموذج",
    "↺ Reimposta al modello"
  ],
  [
    "↺ Restore best-practices",
    "↺ 恢复最佳实践",
    "↺ 모범 사례 복원",
    "↺ ベストプラクティスを復元",
    "↺ استعادة أفضل الممارسات",
    "↺ Ripristina le migliori pratiche"
  ],
  [
    "↻ Re-run readiness checks",
    "↻ 重新运行准备检查",
    "↻ 준비 상태 확인 다시 실행",
    "↻ 準備チェックを再実行",
    "↻ إعادة تشغيل فحوصات الجاهزية",
    "↻ Riesegui i controlli di prontezza"
  ],
  [
    "↻ Refresh",
    "↻ 刷新",
    "↻ 새로 고침",
    "↻ 更新",
    "↻ تحديث",
    "↻ Aggiorna"
  ],
  [
    "↻ Rescan",
    "↻ 重新扫描",
    "↻ 재스캔",
    "↻ 再スキャン",
    "↻ إعادة المسح",
    "↻ Riscansiona"
  ],
  [
    "⇄ 1st → 2nd",
    "⇄ 第1 → 第2",
    "⇄ 1번째 → 2번째",
    "⇄ 1番目 → 2番目",
    "⇄ من الأول → الثاني",
    "⇄ 1° → 2°"
  ],
  [
    "⇄ 2nd → 1st",
    "⇄ 第2 → 第1",
    "⇄ 2번째 → 1번째",
    "⇄ 2番目 → 1番目",
    "⇄ من الثاني → الأول",
    "⇄ 2° → 1°"
  ],
  [
    "⇄ Swap direction",
    "⇄ 交换方向",
    "⇄ 방향 교환",
    "⇄ 方向を入れ替え",
    "⇄ تبديل الاتجاه",
    "⇄ Inverti direzione"
  ],
  [
    "⇱ Make isolated",
    "⇱ 设置为独立",
    "⇱ 단독으로 만들기",
    "⇱ 単独にする",
    "⇱ جعلها معزولة",
    "⇱ Rendi isolato"
  ],
  [
    "⇲ Make not-isolated",
    "⇲ 设置为非独立",
    "⇲ 단독이 아닌 상태로 만들기",
    "⇲ 単独でないにする",
    "⇲ جعلها غير معزولة",
    "⇲ Rendi non isolato"
  ],
  [
    "+ add",
    "+ 添加",
    "+ 추가",
    "+ 追加",
    "+ إضافة",
    "+ Aggiungi"
  ],
  [
    "+ Add",
    "+ 添加",
    "+ 추가",
    "+ 追加",
    "+ إضافة",
    "+ Aggiungi"
  ],
  [
    "＋ Add",
    "＋ 添加",
    "＋ 추가",
    "＋ 追加",
    "＋ إضافة",
    "＋ Aggiungi"
  ],
  [
    "+ add agent",
    "+ 添加代理",
    "+ 에이전트 추가",
    "+ エージェントを追加",
    "+ إضافة وكيل",
    "+ Aggiungi agente"
  ],
  [
    "+ Add agent",
    "+ 添加代理",
    "+ 에이전트 추가",
    "+ エージェントを追加",
    "+ أضف وكيل",
    "+ Aggiungi agente"
  ],
  [
    "+ Add Server",
    "+ 添加服务器",
    "+ 서버 추가",
    "+ サーバーを追加",
    "+ إضافة خادم",
    "+ Aggiungi server"
  ],
  [
    "+ Allow",
    "+ 允许",
    "+ 허용",
    "+ 許可",
    "+ السماح",
    "+ Consenti"
  ],
  [
    "+ equip",
    "+ 装备",
    "+ 장착",
    "+ 装備",
    "+ تجهيز",
    "+ equipaggia"
  ],
  [
    "＋ Get more skills…",
    "＋ 获取更多技能…",
    "＋ 더 많은 기술 얻기…",
    "＋ もっとスキルを手に入れる…",
    "＋ احصل على المزيد من المهارات…",
    "＋ Ottieni più abilità…"
  ],
  [
    "＋ Import",
    "＋ 导入",
    "＋ 가져오기",
    "＋ インポート",
    "＋ استيراد",
    "＋ Importa"
  ],
  [
    "+ New",
    "+ 新建",
    "+ 새로 만들기",
    "+ 新規",
    "+ جديد",
    "+ Nuovo"
  ],
  [
    "＋ New",
    "＋ 新建",
    "＋ 새로 만들기",
    "＋ 新規",
    "＋ جديد",
    "＋ Nuovo"
  ],
  [
    "+ New custom agent",
    "+ 新建自定义代理",
    "+ 새 맞춤형 에이전트",
    "+ 新しいカスタムエージェント",
    "+ وكيل مخصص جديد",
    "+ Nuovo agente personalizzato"
  ],
  [
    "＋ New page",
    "＋ 新页面",
    "＋ 새 페이지",
    "＋ 新しいページ",
    "＋ صفحة جديدة",
    "＋ Nuova pagina"
  ],
  [
    "+ New project",
    "+ 新建项目",
    "+ 새 프로젝트",
    "+ 新しいプロジェクト",
    "+ مشروع جديد",
    "+ Nuovo progetto"
  ],
  [
    "+ New project from",
    "+ 从新建项目",
    "+ 프로젝트에서 새로 만들기",
    "+ から新しいプロジェクト",
    "+ مشروع جديد من",
    "+ Nuovo progetto da"
  ],
  [
    "+ Pair by IP",
    "+ 按 IP 配对",
    "+ IP로 페어링",
    "+ IPでペアリング",
    "+ الاقتران بواسطة عنوان IP",
    "+ Associa per IP"
  ],
  [
    "+ Save login",
    "+ 保存登录",
    "+ 로그인 저장",
    "+ ログイン情報を保存",
    "+ حفظ تسجيل الدخول",
    "+ Salva login"
  ],
  [
    "+10 XP ✨",
    "+10 经验 ✨",
    "+10 경험치 ✨",
    "+10 XP ✨",
    "+10 نقاط خبرة ✨",
    "+10 XP ✨"
  ],
  [
    "<select a model>",
    "<选择一个模型>",
    "<모델 선택>",
    "<モデルを選択>",
    "<اختر نموذجًا>",
    "<select un modello>"
  ],
  [
    "<tunnel>/line",
    "<隧道>/线路",
    "<터널>/선",
    "<トンネル>/線",
    "<نفق>/خط",
    "<tunnel>/linea"
  ],
  [
    "~/.owllm/agent_secrets.json",
    "~/.owllm/agent_secrets.json",
    "~/.owllm/agent_secrets.json",
    "~/.owllm/agent_secrets.json",
    "~/.owllm/agent_secrets.json",
    "~/.owllm/agent_secrets.json"
  ],
  [
    "~/.owllm/mcp_config.json",
    "~/.owllm/mcp_config.json",
    "~/.owllm/mcp_config.json",
    "~/.owllm/mcp_config.json",
    "~/.owllm/mcp_config.json",
    "~/.owllm/mcp_config.json"
  ],
  [
    "Coding agent",
    "编码代理",
    "코딩 에이전트",
    "コーディングエージェント",
    "وكيل الترميز",
    "Agente di codifica"
  ],
  [
    "⏬ Resume download",
    "⏬ 下载简历",
    "⏬ 이력서 다운로드",
    "⏬ 履歴書をダウンロード",
    "⏬ تنزيل السيرة الذاتية",
    "⏬ Scarica curriculum"
  ],
  [
    "⏱ {0} — started {1}, finished {2}",
    "⏱ {0} — 开始于 {1}，完成于 {2}",
    "⏱ {0} — {1} 시작, {2} 완료",
    "⏱ {0} — {1}に開始、{2}に終了",
    "⏱ {0} — بدأ {1}، انتهى {2}",
    "⏱ {0} — iniziato {1}, finito {2}"
  ],
  [
    "⏱ Stopped — starts automatically on the first agent run (or click Start to warm it now).",
    "⏱ 已停止 — 在第一次代理运行时自动启动（或点击“开始”立即预热）。",
    "⏱ 중지됨 — 첫 번째 에이전트 실행 시 자동으로 시작됩니다(또는 지금 준비하려면 시작 버튼 클릭).",
    "⏱ 停止中 — 最初のエージェント実行時に自動で開始されます（または今すぐウォームアップするには「開始」をクリックしてください）。",
    "⏱ متوقف — يبدأ تلقائيًا عند تشغيل الوكيل الأول (أو انقر على ابدأ لتسخينه الآن).",
    "⏱ Fermato — si avvia automaticamente al primo avvio dell'agente (o clicca su Avvia per riscaldarlo ora)."
  ],
  [
    "⏳ {0} running… {1}",
    "⏳ {0} 运行中… {1}",
    "⏳ {0} 실행 중… {1}",
    "⏳ {0} 実行中… {1}",
    "⏳ {0} جارٍ التشغيل… {1}",
    "⏳ {0} in esecuzione… {1}"
  ],
  [
    "⏳ Checking isolation (WSL)…",
    "⏳ 检查隔离环境（WSL）…",
    "⏳ 격리(WSL) 확인 중…",
    "⏳ 分離モード（WSL）を確認中…",
    "⏳ التحقق من العزل (WSL)…",
    "⏳ Verifica isolamento (WSL)…"
  ],
  [
    "⏳ Checking…",
    "⏳ 检查中…",
    "⏳ 확인 중…",
    "⏳ 確認中…",
    "⏳ جارٍ التحقق…",
    "⏳ Verifica in corso…"
  ],
  [
    "⏳ Connecting…",
    "⏳ 连接中…",
    "⏳ 연결 중…",
    "⏳ 接続中…",
    "⏳ جارٍ الاتصال…",
    "⏳ Connessione in corso…"
  ],
  [
    "⏳ First run downloads the MCP package via npx — usually 20-60s. Wait for it; clicking Start again won't help.",
    "⏳ 首次运行通过 npx 下载 MCP 包 — 通常需 20-60 秒。请等待；再次点击“开始”无效。",
    "⏳ 첫 실행 시 npx를 통해 MCP 패키지 다운로드 — 일반적으로 20~60초 소요. 기다려 주세요; 다시 시작 버튼을 클릭해도 도움이 되지 않습니다.",
    "⏳ 初回実行では npx を通じて MCP パッケージをダウンロードします — 通常20〜60秒かかります。ダウンロードが完了するまでお待ちください。「開始」を再度クリックしても効果はありません。",
    "⏳ التحميل الأول لحزمة MCP عبر npx — عادةً 20-60 ثانية. انتظر؛ النقر على ابدأ مرة أخرى لن يساعد.",
    "⏳ La prima esecuzione scarica il pacchetto MCP tramite npx — di solito 20-60s. Attendere; cliccare di nuovo Avvia non aiuterà."
  ],
  [
    "⏳ Installing engine…",
    "⏳ 安装引擎…",
    "⏳ 엔진 설치 중…",
    "⏳ エンジンをインストール中…",
    "⏳ تثبيت المحرك…",
    "⏳ Installazione motore…"
  ],
  [
    "⏳ Installing uv runtime…",
    "⏳ 安装 uv 运行时…",
    "⏳ uv 런타임 설치 중…",
    "⏳ uv ランタイムをインストール中…",
    "⏳ تثبيت بيئة uv…",
    "⏳ Installazione runtime uv…"
  ],
  [
    "⏳ Installing…",
    "⏳ 安装中…",
    "⏳ 설치 중…",
    "⏳ インストール中…",
    "⏳ جاري التثبيت…",
    "⏳ Installazione…"
  ],
  [
    "⏳ Preparing…",
    "⏳ 准备中…",
    "⏳ 준비 중…",
    "⏳ 準備中…",
    "⏳ جارٍ التحضير…",
    "⏳ Preparazione…"
  ],
  [
    "⏳ Starting…",
    "⏳ 启动中…",
    "⏳ 시작 중…",
    "⏳ 開始中…",
    "⏳ بدء…",
    "⏳ Avvio…"
  ],
  [
    "⏳ Warming up model · {0}s",
    "⏳ 预热模型 · {0}s",
    "⏳ 모델 워밍업 · {0}초",
    "⏳ モデルをウォームアップ中 · {0}秒",
    "⏳ تسخين النموذج · {0} ث",
    "⏳ Riscaldamento modello · {0}s"
  ],
  [
    "⏳ Working…",
    "⏳ 工作中…",
    "⏳ 작업 중…",
    "⏳ 作業中…",
    "⏳ جاري العمل…",
    "⏳ Funzionamento…"
  ],
  [
    "⏸ Stopped — Auto-start is off, so it only runs when you click Start.",
    "⏸ 已停止 — 自动启动已关闭，因此只有在点击开始时才会运行。",
    "⏸ 중지됨 — 자동 시작이 꺼져 있어 시작을 클릭할 때만 실행됩니다.",
    "⏸ 停止 — 自動開始はオフになっているため、[開始] をクリックした時のみ実行されます。",
    "⏸ متوقف — التشغيل التلقائي مغلق، لذا يعمل فقط عند النقر على بدء.",
    "⏸ Arrestato — L'avvio automatico è disattivato, quindi funziona solo quando clicchi Avvia."
  ],
  [
    "⏹ Stop",
    "⏹ 停止",
    "⏹ 중지",
    "⏹ 停止",
    "⏹ توقف",
    "⏹ Ferma"
  ],
  [
    "⏹ Stop selected",
    "⏹ 停止选中",
    "⏹ 선택 항목 중지",
    "⏹ 選択した停止",
    "⏹ توقف المحدد",
    "⏹ Ferma selezionato"
  ],
  [
    "⏹ Stop training",
    "⏹ 停止训练",
    "⏹ 학습 중지",
    "⏹ トレーニング停止",
    "⏹ توقف التدريب",
    "⏹ Arresta l'addestramento"
  ],
  [
    "── Saved ──",
    "── 已保存 ──",
    "── 저장됨 ──",
    "── 保存済み ──",
    "── تم الحفظ ──",
    "── Salvato ──"
  ],
  [
    "■ Stop",
    "■ 停止",
    "■ 중지",
    "■ 停止",
    "■ توقف",
    "■ Ferma"
  ],
  [
    "▶ Demo",
    "▶ 演示",
    "▶ 데모",
    "▶ デモ",
    "▶ عرض توضيحي",
    "▶ Demo"
  ],
  [
    "▶ Enable remote control on this PC",
    "▶ 在此电脑上启用远程控制",
    "▶ 이 PC에서 원격 제어 활성화",
    "▶ このPCでリモート制御を有効にする",
    "▶ تمكين التحكم عن بعد على هذا الكمبيوتر",
    "▶ Abilita controllo remoto su questo PC"
  ],
  [
    "▶ Run",
    "▶ 运行",
    "▶ 실행",
    "▶ 実行",
    "▶ تشغيل",
    "▶ Esegui"
  ],
  [
    "▶ Show tools",
    "▶ 显示工具",
    "▶ 도구 표시",
    "▶ ツールを表示",
    "▶ عرض الأدوات",
    "▶ Mostra strumenti"
  ],
  [
    "▶ Start",
    "▶ 开始",
    "▶ 시작",
    "▶ 開始",
    "▶ بدء",
    "▶ Avvia"
  ],
  [
    "▶ Start queue",
    "▶ 开始队列",
    "▶ 대기열 시작",
    "▶ キューを開始",
    "▶ بدء الطابور",
    "▶ Avvia coda"
  ],
  [
    "▶ Start training",
    "▶ 开始训练",
    "▶ 학습 시작",
    "▶ トレーニング開始",
    "▶ بدء التدريب",
    "▶ Avvia addestramento"
  ],
  [
    "▼ Hide tools",
    "▼ 隐藏工具",
    "▼ 도구 숨기기",
    "▼ ツールを隠す",
    "▼ إخفاء الأدوات",
    "▼ Nascondi strumenti"
  ],
  [
    "◆ orch",
    "◆ orch",
    "◆ orch",
    "◆ orch",
    "◆ أورتش",
    "◆ orch"
  ],
  [
    "◆ Orchestrator",
    "◆ 调度器",
    "◆ 오케스트레이터",
    "◆ オーケストレーター",
    "◆ منسق",
    "◆ Orchestratore"
  ],
  [
    "◇ Notices (",
    "◇ 通知 (",
    "◇ 알림 (",
    "◇ お知らせ (",
    "◇ الإشعارات (",
    "◇ Avvisi ("
  ],
  [
    "○ not created yet",
    "○ 尚未创建",
    "○ 아직 생성되지 않음",
    "○ まだ作成されていません",
    "○ لم يتم إنشاؤه بعد",
    "○ non ancora creato"
  ],
  [
    "○ not open",
    "○ 未开启",
    "○ 열리지 않음",
    "○ 開かない",
    "○ مغلق",
    "○ non aperto"
  ],
  [
    "● committed",
    "● 已提交",
    "● 커밋됨",
    "● コミット済み",
    "● ملتزم",
    "● impegnato"
  ],
  [
    "● Live:",
    "● 直播：",
    "● 라이브:",
    "● ライブ:",
    "● مباشر:",
    "● In diretta:"
  ],
  [
    "● open",
    "● 开启",
    "● 열기",
    "● 開く",
    "● مفتوح",
    "● aperto"
  ],
  [
    "◧ Hide 2nd agent",
    "◧ 隐藏第二个代理",
    "◧ 두 번째 에이전트 숨기기",
    "◧ 2番目のエージェントを非表示",
    "◧ إخفاء الوكيل الثاني",
    "◧ Nascondi 2° agente"
  ],
  [
    "◨ Show 2nd agent",
    "◨ 显示第二个代理",
    "◨ 두 번째 에이전트 표시",
    "◨ 2番目のエージェントを表示",
    "◨ عرض الوكيل الثاني",
    "◨ Mostra 2° agente"
  ],
  [
    "★ Tokens",
    "★ 代币",
    "★ 토큰",
    "★ トークン",
    "★ الرموز",
    "★ Gettoni"
  ],
  [
    "♥ Health",
    "♥ 健康",
    "♥ 건강",
    "♥ ヘルス",
    "♥ الصحة",
    "♥ Salute"
  ],
  [
    "⚙️ Custom",
    "⚙️ 自定义",
    "⚙️ 맞춤",
    "⚙️ カスタム",
    "⚙️ مخصص",
    "⚙️ Personalizza"
  ],
  [
    "⚙ Edit",
    "⚙ 编辑",
    "⚙ 편집",
    "⚙ 編集",
    "⚙ تعديل",
    "⚙ Modifica"
  ],
  [
    "⚙ edit team",
    "⚙ 编辑团队",
    "⚙ 팀 편집",
    "⚙ チームを編集",
    "⚙ تحرير الفريق",
    "⚙ Modifica squadra"
  ],
  [
    "⚙ Edit team",
    "⚙ 编辑团队",
    "⚙ 팀 편집",
    "⚙ チームを編集",
    "⚙ تعديل الفريق",
    "⚙ Modifica squadra"
  ],
  [
    "⚙ Execution & Verification",
    "⚙ 执行与验证",
    "⚙ 실행 및 검증",
    "⚙ 実行 & 検証",
    "⚙ التنفيذ والتحقق",
    "⚙ Esecuzione e verifica"
  ],
  [
    "⚙ Generate dataset",
    "⚙ 生成数据集",
    "⚙ 데이터셋 생성",
    "⚙ データセットを生成",
    "⚙ توليد مجموعة البيانات",
    "⚙ Genera dataset"
  ],
  [
    "⚙️ Generation Parameters",
    "⚙️ 生成参数",
    "⚙️ 생성 매개변수",
    "⚙️ 生成パラメータ",
    "⚙️ معلمات التوليد",
    "⚙️ Parametri di generazione"
  ],
  [
    "⚙ Open Workbench",
    "⚙ 打开工作台",
    "⚙ 워크벤치 열기",
    "⚙ ワークベンチを開く",
    "⚙ فتح ورشة العمل",
    "⚙ Apri Workbench"
  ],
  [
    "⚙ Project settings{0}",
    "⚙ 项目设置{0}",
    "⚙ 프로젝트 설정{0}",
    "⚙ プロジェクト設定{0}",
    "⚙ إعدادات المشروع{0}",
    "⚙ Impostazioni progetto{0}"
  ],
  [
    "⚙ Repository setup",
    "⚙ 仓库设置",
    "⚙ 저장소 설정",
    "⚙ リポジトリ設定",
    "⚙ إعداد المستودع",
    "⚙ Configurazione repository"
  ],
  [
    "⚙ Set up repo",
    "⚙ 设置仓库",
    "⚙ 저장소 설정",
    "⚙ リポジトリを設定",
    "⚙ إعداد المستودع",
    "⚙ Configura repo"
  ],
  [
    "⚙ Tools",
    "⚙ 工具",
    "⚙ 도구",
    "⚙ ツール",
    "⚙ الأدوات",
    "⚙ Strumenti"
  ],
  [
    "⚙️ TRAINING PARAMETERS",
    "⚙️ 训练参数",
    "⚙️ 훈련 매개변수",
    "⚙️ トレーニングパラメータ",
    "⚙️ معلمات التدريب",
    "⚙️ PARAMETRI DI ADDDESTRAMENTO"
  ],
  [
    "⚠ can’t read this folder —",
    "⚠ 无法读取此文件夹 —",
    "⚠ 이 폴더를 읽을 수 없습니다 —",
    "⚠ このフォルダーを読み取れません —",
    "⚠ لا يمكن قراءة هذا المجلد —",
    "⚠ non riesco a leggere questa cartella —"
  ],
  [
    "⚠ Couldn't save:",
    "⚠ 无法保存：",
    "⚠ 저장할 수 없습니다:",
    "⚠ 保存できませんでした:",
    "⚠ تعذر الحفظ:",
    "⚠ Impossibile salvare:"
  ],
  [
    "⚠ Found on Windows: {0}, but nothing landed in the sandbox.",
    "⚠ 在 Windows 上发现: {0}，但没有内容落入沙箱。",
    "⚠ Windows에서 발견됨: {0}, 하지만 샌드박스에는 아무 것도 들어가지 않았습니다.",
    "⚠ Windowsで見つかりました: {0}、しかしサンドボックスには何も入りませんでした。",
    "⚠ تم العثور على Windows: {0}، ولكن لم يتم وضع أي شيء في الصندوق الرمل.",
    "⚠ Trovato su Windows: {0}, ma nulla è finito nella sandbox."
  ],
  [
    "⚠ Freed {0} but {1} delete(s) failed — {2}",
    "⚠ 已释放 {0}，但 {1} 个删除失败 — {2}",
    "⚠ {0} 해제됨, 하지만 {1} 삭제 실패 — {2}",
    "⚠ {0} を解放しましたが {1} 件の削除に失敗しました — {2}",
    "⚠ تم تحرير {0} ولكن فشل {1} حذف — {2}",
    "⚠ Liberati {0} ma {1} eliminazione/i fallita/e — {2}"
  ],
  [
    "⚠ HOST ACCESS — sandbox OFF",
    "⚠ 主机访问 — 沙箱关闭",
    "⚠ 호스트 접근 — 샌드박스 OFF",
    "⚠ ホストアクセス — サンドボックスオフ",
    "⚠ وصول المضيف — الصندوق الرمل متوقف",
    "⚠ ACCESSO HOST — sandbox SPENTA"
  ],
  [
    "⚠ incomplete download",
    "⚠ 下载不完整",
    "⚠ 다운로드 불완전",
    "⚠ ダウンロードが不完全です",
    "⚠ تحميل غير مكتمل",
    "⚠ download incompleto"
  ],
  [
    "⚠️ No GPUs detected",
    "⚠️ 未检测到 GPU",
    "⚠️ GPU가 감지되지 않음",
    "⚠️ GPUが検出されません",
    "⚠️ لم يتم اكتشاف أي وحدات معالجة رسومية",
    "⚠️ Nessuna GPU rilevata"
  ],
  [
    "⚠ no password",
    "⚠ 无密码",
    "⚠ 비밀번호 없음",
    "⚠ パスワードなし",
    "⚠ لا توجد كلمة مرور",
    "⚠ nessuna password"
  ],
  [
    "⚠ No sandbox engine — agents would run on the host. {0}",
    "⚠ 无沙箱引擎 — 代理将运行在主机上。{0}",
    "⚠ 샌드박스 엔진 없음 — 에이전트가 호스트에서 실행됩니다. {0}",
    "⚠ サンドボックスエンジンなし — エージェントはホストで実行されます。{0}",
    "⚠ لا توجد محرك صندوق الرمل — ستعمل الوكلاء على المضيف. {0}",
    "⚠ Nessun motore sandbox — gli agenti verrebbero eseguiti sull'host. {0}"
  ],
  [
    "⚠ Not on disk yet — download it before training (training does not auto-fetch).",
    "⚠ 尚未在磁盘上 — 在训练前下载它（训练不会自动获取）。",
    "⚠ 아직 디스크에 없음 — 훈련 전에 다운로드하십시오 (훈련은 자동으로 가져오지 않음).",
    "⚠ まだディスクにありません — トレーニング前にダウンロードしてください（トレーニングは自動取得しません）。",
    "⚠ لم يتم حفظه على القرص بعد — قم بتنزيله قبل التدريب (التدريب لا يقوم بتنزيل تلقائي).",
    "⚠ Non ancora su disco — scaricalo prima dell'addestramento (l'addestramento non lo recupera automaticamente)."
  ],
  [
    "⚠️ One manual step: enable virtualization in your BIOS",
    "⚠️ 一步手动操作：在 BIOS 中启用虚拟化",
    "⚠️ 수동 단계 하나: BIOS에서 가상화 활성화",
    "⚠️ 手動でのステップが一つ: BIOSで仮想化を有効にしてください",
    "⚠️ خطوة يدوية واحدة: قم بتمكين الافتراضية في BIOS الخاص بك",
    "⚠️ Un passaggio manuale: abilita la virtualizzazione nel tuo BIOS"
  ],
  [
    "⚠️ Plain HTTP — the key and traffic are unencrypted. Use only on a",
    "⚠️ 明文 HTTP — 密钥和流量未加密。仅在",
    "⚠️ 일반 HTTP — 키와 트래픽이 암호화되지 않았습니다. 사용은 다음에서만 가능합니다",
    "⚠️ プレーンHTTP — キーと通信は暗号化されていません。使用するのは",
    "⚠️ HTTP عادي — المفتاح وحركة المرور غير مشفرين. استخدمه فقط على",
    "⚠️ HTTP semplice — la chiave e il traffico non sono criptati. Usare solo su una"
  ],
  [
    "⚠ React render crash",
    "⚠ React 渲染崩溃",
    "⚠ React 렌더링 충돌",
    "⚠ Reactレンダークラッシュ",
    "⚠ تعطل عرض React",
    "⚠ Crash nel rendering di React"
  ],
  [
    "⚠ review:",
    "⚠ 审查：",
    "⚠ 리뷰:",
    "⚠ レビュー:",
    "⚠ مراجعة:",
    "⚠ revisione:"
  ],
  [
    "⚠️ Secrets are stored in plaintext at",
    "⚠️ 密钥以明文存储于",
    "⚠️ 비밀 정보가 평문으로 저장됨",
    "⚠️ シークレットはプレーンテキストで保存されています：",
    "⚠️ يتم تخزين الأسرار كنص عادي في",
    "⚠️ I segreti sono memorizzati in testo chiaro su"
  ],
  [
    "⚡ {0} tok/s",
    "⚡ {0} tok/s",
    "⚡ {0} 토큰/초",
    "⚡ {0} トークン/秒",
    "⚡ {0} توك/ث",
    "⚡ {0} tok/s"
  ],
  [
    "⚡ Auto",
    "⚡ 自动",
    "⚡ 자동",
    "⚡ 自動",
    "⚡ تلقائي",
    "⚡ Auto"
  ],
  [
    "⚡ Feed",
    "⚡ 订阅",
    "⚡ 피드",
    "⚡ フィード",
    "⚡ تغذية",
    "⚡ Feed"
  ],
  [
    "⚡ QLoRA",
    "⚡ QLoRA",
    "⚡ QLoRA",
    "⚡ QLoRA",
    "⚡ QLoRA",
    "⚡ QLoRA"
  ],
  [
    "⚡ Quantized",
    "⚡ 量化",
    "⚡ 양자화됨",
    "⚡ 量子化済み",
    "⚡ كمي",
    "⚡ Quantizzato"
  ],
  [
    "⚡ Re-feed",
    "⚡ 重新订阅",
    "⚡ 재피드",
    "⚡ 再フィード",
    "⚡ إعادة التغذية",
    "⚡ Re-feed"
  ],
  [
    "⚡ Solo",
    "⚡ 单独",
    "⚡ 솔로",
    "⚡ ソロ",
    "⚡ فردي",
    "⚡ Solo"
  ],
  [
    "⚡ Start batch",
    "⚡ 开始批处理",
    "⚡ 배치 시작",
    "⚡ バッチ開始",
    "⚡ بدء الدُفعة",
    "⚡ Avvia batch"
  ],
  [
    "⚪ MCP tools are",
    "⚪ MCP 工具是",
    "⚪ MCP 도구는",
    "⚪ MCPツールは",
    "⚪ أدوات MCP هي",
    "⚪ Gli strumenti MCP sono"
  ],
  [
    "⚪ MCP tools OFF",
    "⚪ MCP 工具关闭",
    "⚪ MCP 도구 OFF",
    "⚪ MCPツール OFF",
    "⚪ أدوات MCP متوقفة",
    "⚪ Strumenti MCP OFF"
  ],
  [
    "⚪ Stopped",
    "⚪ 已停止",
    "⚪ 중지됨",
    "⚪ 停止",
    "⚪ متوقف",
    "⚪ Interrotto"
  ],
  [
    "⛔ Stop",
    "⛔ 停止",
    "⛔ 중지",
    "⛔ 停止",
    "⛔ إيقاف",
    "⛔ Ferma"
  ],
  [
    "✂ Crop to the OWLLM app (frame included)",
    "✂ 裁剪到 OWLLM 应用（包含框架）",
    "✂ OWLLM 앱에 맞게 자르기 (프레임 포함)",
    "✂ OWLLMアプリにクロップ（フレーム含む）",
    "✂ اقتصاص لتطبيق OWLLM (تشمل الإطار)",
    "✂ Ritaglia all'app OWLLM (cornice inclusa)"
  ],
  [
    "✅ Abliterated → {0}",
    "✅ 已清除 → {0}",
    "✅ 완전히 제거됨 → {0}",
    "✅ 完全破壊 → {0}",
    "✅ تم الإبادة → {0}",
    "✅ Obliterato → {0}"
  ],
  [
    "✅ Apply to project & open",
    "✅ 申请项目并打开",
    "✅ 프로젝트에 적용하고 열기",
    "✅ プロジェクトに適用して開く",
    "✅ تقديم المشروع وفتحه",
    "✅ Applica al progetto e apri"
  ],
  [
    "✅ Copied into the project as",
    "✅ 复制到项目中作为",
    "✅ 프로젝트에 복사됨",
    "✅ プロジェクトにコピーされました",
    "✅ تم النسخ إلى المشروع كـ",
    "✅ Copiato nel progetto come"
  ],
  [
    "✅ Deleted {0}",
    "✅ 已删除 {0}",
    "✅ {0} 삭제됨",
    "✅ {0} を削除",
    "✅ تم حذف {0}",
    "✅ Eliminato {0}"
  ],
  [
    "✅ Done",
    "✅ 完成",
    "✅ 완료",
    "✅ 完了",
    "✅ تم",
    "✅ Fatto"
  ],
  [
    "✅ Done → {0}",
    "✅ 完成 → {0}",
    "✅ 완료 → {0}",
    "✅ 完了 → {0}",
    "✅ تم → {0}",
    "✅ Fatto → {0}"
  ],
  [
    "✅ Environment readiness",
    "✅ 环境已准备好",
    "✅ 환경 준비 완료",
    "✅ 環境準備完了",
    "✅ جاهزية البيئة",
    "✅ Prontezza dell'ambiente"
  ],
  [
    "✅ Freed {0} ({1} cache/trash item(s))",
    "✅ 已释放 {0}（{1} 个缓存/垃圾项目）",
    "✅ {0} 해제됨 ({1} 캐시/휴지통 항목)",
    "✅ {0} を解放しました（{1} キャッシュ/ゴミアイテム）",
    "✅ تم تحرير {0} ({1} عنصر/عناصر ذاكرة مؤقتة/مهملات)",
    "✅ Liberato {0} ({1} elemento/i cache/spazzatura)"
  ],
  [
    "✅ GGUF written → {0}",
    "✅ GGUF 已写入 → {0}",
    "✅ GGUF 작성됨 → {0}",
    "✅ GGUF に書き込み → {0}",
    "✅ تم كتابة GGUF → {0}",
    "✅ GGUF scritto → {0}"
  ],
  [
    "✅ Optimal batch size",
    "✅ 最优批量大小",
    "✅ 최적 배치 크기",
    "✅ 最適なバッチサイズ",
    "✅ حجم الدُفعة المثالي",
    "✅ Dimensione batch ottimale"
  ],
  [
    "✅ Trainable",
    "✅ 可训练",
    "✅ 학습 가능",
    "✅ 訓練可能",
    "✅ قابل للتدريب",
    "✅ Allenabile"
  ],
  [
    "✅ WSL is ready",
    "✅ WSL 已准备好",
    "✅ WSL 준비 완료",
    "✅ WSL が準備完了",
    "✅ WSL جاهز",
    "✅ WSL è pronto"
  ],
  [
    "✍ Writing partner",
    "✍ 写作伙伴",
    "✍ 작성 파트너",
    "✍ ライティングパートナー",
    "✍ شريك الكتابة",
    "✍ Partner di scrittura"
  ],
  [
    "✎ Edit",
    "✎ 编辑",
    "✎ 편집",
    "✎ 編集",
    "✎ تعديل",
    "✎ Modifica"
  ],
  [
    "✎ Editing…",
    "✎ 正在编辑…",
    "✎ 편집 중…",
    "✎ 編集中…",
    "✎ جارٍ التعديل…",
    "✎ Modificando…"
  ],
  [
    "✏ Custom",
    "✏ 自定义",
    "✏ 사용자 정의",
    "✏ カスタム",
    "✏ مخصص",
    "✏ Personalizzato"
  ],
  [
    "✏️ Custom HuggingFace id…",
    "✏️ 自定义 HuggingFace ID…",
    "✏️ 커스텀 HuggingFace id…",
    "✏️ カスタム HuggingFace ID…",
    "✏️ معرف HuggingFace مخصص…",
    "✏️ ID HuggingFace personalizzato…"
  ],
  [
    "✏ User Input",
    "✏ 用户输入",
    "✏ 사용자 입력",
    "✏ ユーザー入力",
    "✏ إدخال المستخدم",
    "✏ Input utente"
  ],
  [
    "✓ API keys available to isolated agents.",
    "✓ API 密钥可用于隔离代理。",
    "✓ 격리된 에이전트에서 사용 가능한 API 키.",
    "✓ 孤立したエージェント用のAPIキーが利用可能です。",
    "✓ مفاتيح API متاحة للوكلاء المنعزلين.",
    "✓ Chiavi API disponibili per agenti isolati."
  ],
  [
    "✓ Approve (read-only)",
    "✓ 批准（只读）",
    "✓ 승인(읽기 전용)",
    "✓ 承認（読み取り専用）",
    "✓ الموافقة (قراءة فقط)",
    "✓ Approvare (sola lettura)"
  ],
  [
    "✓ Brief done — Close",
    "✓ 简报完成 — 关闭",
    "✓ 브리핑 완료 — 닫기",
    "✓ ブリーフ完了 — 閉じる",
    "✓ الملخص تم — إغلاق",
    "✓ Breve completato — Chiudi"
  ],
  [
    "✓ clean",
    "✓ 清理",
    "✓ 정리됨",
    "✓ クリーン",
    "✓ نظيف",
    "✓ pulito"
  ],
  [
    "✓ Copied",
    "✓ 已复制",
    "✓ 복사됨",
    "✓ コピー済み",
    "✓ تم النسخ",
    "✓ Copiato"
  ],
  [
    "✓ Done",
    "✓ 完成",
    "✓ 완료",
    "✓ 完了",
    "✓ تم",
    "✓ Fatto"
  ],
  [
    "✓ done for you:",
    "✓ 为你完成：",
    "✓ 완료됨:",
    "✓ あなたのために完了：",
    "✓ تم لك:",
    "✓ fatto per te:"
  ],
  [
    "✓ Downloaded",
    "✓ 已下载",
    "✓ 다운로드됨",
    "✓ ダウンロード済み",
    "✓ تم التنزيل",
    "✓ Scaricato"
  ],
  [
    "✓ GitHub connected as",
    "✓ GitHub 已连接为",
    "✓ GitHub에 연결됨",
    "✓ GitHubに接続済み",
    "✓ تم الاتصال بـ GitHub كـ",
    "✓ GitHub connesso come"
  ],
  [
    "✓ Project Card looks congruent with the repo.",
    "✓ 项目卡与仓库一致。",
    "✓ 프로젝트 카드가 리포지토리와 일치함.",
    "✓ プロジェクトカードがリポジトリと整合しています。",
    "✓ بطاقة المشروع تبدو متوافقة مع المستودع.",
    "✓ La scheda del progetto appare congruente con il repository."
  ],
  [
    "✓ Restart Memory Hugging Face — C:\\Users\\mc\\.cache\\huggingface",
    "✓ 重新启动 Memory Hugging Face — C:\\Users\\mc\\.cache\\huggingface",
    "✓ 메모리 재시작 Hugging Face — C:\\Users\\mc\\.cache\\huggingface",
    "✓ メモリを再起動 Hugging Face — C:\\Users\\mc\\.cache\\huggingface",
    "✓ إعادة تشغيل ذاكرة Hugging Face — C:\\Users\\mc\\.cache\\huggingface",
    "✓ Riavvia memoria Hugging Face — C:\\Users\\mc\\.cache\\huggingface"
  ],
  [
    "✓ Saved",
    "✓ 已保存",
    "✓ 저장됨",
    "✓ 保存済み",
    "✓ تم الحفظ",
    "✓ Salvato"
  ],
  [
    "✓ Saved {0} pair(s) → {1}. Pick it on the Train page as your dataset.",
    "✓ 已保存 {0} 对 → {1}。在训练页面将其作为你的数据集选择。",
    "✓ {0} 쌍 저장됨 → {1}. 학습 페이지에서 데이터셋으로 선택하세요.",
    "✓ {0} ペアを保存 → {1}。Trainページでデータセットとして選択してください。",
    "✓ تم حفظ {0} زوج/أزواج → {1}. اختره في صفحة التدريب كمجموعة بياناتك.",
    "✓ Salvato {0} coppia(e) → {1}. Sceglila nella pagina Addestramento come tuo dataset."
  ],
  [
    "✓ Saved →",
    "✓ 已保存 →",
    "✓ 저장됨 →",
    "✓ 保存 →",
    "✓ تم الحفظ →",
    "✓ Salvato →"
  ],
  [
    "✓ Signed in as @",
    "✓ 已登录为 @",
    "✓ @로 로그인됨",
    "✓ でサインイン中 @",
    "✓ تم تسجيل الدخول باسم @",
    "✓ Connesso come @"
  ],
  [
    "✓ Structurally valid — every agent reachable, all bases resolve.",
    "✓ 结构有效 — 每个代理可访问，所有基础完成解析。",
    "✓ 구조적으로 유효 — 모든 에이전트 접근 가능, 모든 기반 해결.",
    "✓ 構造的に有効 — すべてのエージェントが到達可能で、すべてのベースが解決される。",
    "✓ صالح من الناحية الهيكلية — يمكن الوصول إلى كل وكيل، جميع القواعد تحل.",
    "✓ Strutturalmente valido — ogni agente raggiungibile, tutte le basi risolvono."
  ],
  [
    "✓ Synced into sandbox: {0} — isolated agents are authenticated.",
    "✓ 已同步到沙箱：{0} — 孤立的代理已认证。",
    "✓ 샌드박스에 동기화됨: {0} — 격리된 에이전트 인증됨.",
    "✓ サンドボックスに同期済み: {0} — 孤立したエージェントは認証されている。",
    "✓ متزامن مع الصندوق الرمل: {0} — الوكلاء المعزولون تم التحقق من هويتهم.",
    "✓ Sincronizzato nel sandbox: {0} — agenti isolati sono autenticati."
  ],
  [
    "✓ Team applied — Close & open canvas",
    "✓ 团队已申请 — 关闭并打开画布",
    "✓ 팀 적용 — 캔버스 닫기 및 열기",
    "✓ チームが適用 — キャンバスを閉じて開く",
    "✓ الفريق طبق — إغلاق وفتح اللوحة",
    "✓ Squadra applicata — Chiudi e apri tela"
  ],
  [
    "✓ Used for training",
    "✓ 用于训练",
    "✓ 훈련에 사용됨",
    "✓ トレーニングに使用",
    "✓ مستخدم للتدريب",
    "✓ Usato per l'addestramento"
  ],
  [
    "✓ Using",
    "✓ 正在使用",
    "✓ 사용 중",
    "✓ 使用中",
    "✓ جاري الاستخدام",
    "✓ In uso"
  ],
  [
    "✕ clear",
    "✕ 清除",
    "✕ 삭제",
    "✕ クリア",
    "✕ مسح",
    "✕ pulire"
  ],
  [
    "✕ close",
    "✕ 关闭",
    "✕ 닫기",
    "✕ 閉じる",
    "✕ أغلق",
    "✕ Chiudi"
  ],
  [
    "✕ Close",
    "✕ 关闭",
    "✕ 닫기",
    "✕ 閉じる",
    "✕ إغلاق",
    "✕ Chiudi"
  ],
  [
    "✕ Deny",
    "✕ 拒绝",
    "✕ 거부",
    "✕ 拒否",
    "✕ رفض",
    "✕ Rifiuta"
  ],
  [
    "✨ Organize",
    "✨ 组织",
    "✨ 정리",
    "✨ 整理",
    "✨ تنظيم",
    "✨ Organizza"
  ],
  [
    "✨ Organizing…",
    "✨ 正在组织…",
    "✨ 정리 중…",
    "✨ 整理中…",
    "✨ جاري التنظيم…",
    "✨ Organizzazione in corso…"
  ],
  [
    "✨ Use recommended",
    "✨ 使用推荐",
    "✨ 권장 사용",
    "✨ 推奨の使用",
    "✨ استخدم الموصى به",
    "✨ Usa consigliato"
  ],
  [
    "✨ Why connect GitHub? — see what you unlock",
    "✨ 为什么连接 GitHub？ — 查看您解锁的内容",
    "✨ GitHub 연결 이유? — 잠금 해제 내용을 확인",
    "✨ GitHub に接続する理由 — 解除できる内容を確認",
    "✨ لماذا توصيل GitHub؟ — شاهد ما تفتحه",
    "✨ Perché connettere GitHub? — vedi cosa sblocchi"
  ],
  [
    "❌ {0} — see logs below",
    "❌ {0} — 请查看以下日志",
    "❌ {0} — 아래 로그 확인",
    "❌ {0} — 下のログを確認",
    "❌ {0} — راجع السجلات أدناه",
    "❌ {0} — vedi i registri qui sotto"
  ],
  [
    "❌ Delete failed: {0}",
    "❌ 删除失败：{0}",
    "❌ 삭제 실패: {0}",
    "❌ 削除失敗: {0}",
    "❌ فشل الحذف: {0}",
    "❌ Eliminazione fallita: {0}"
  ],
  [
    "❌ Failed to start",
    "❌ 启动失败",
    "❌ 시작 실패",
    "❌ 起動に失敗",
    "❌ فشل في البدء",
    "❌ Avvio fallito"
  ],
  [
    "❌ Failed: {0}",
    "❌ 失败: {0}",
    "❌ 실패: {0}",
    "❌ 失敗: {0}",
    "❌ فشل: {0}",
    "❌ Fallito: {0}"
  ],
  [
    "❌ GGUF export failed: {0} — see logs below",
    "❌ GGUF 导出失败: {0} — 请查看以下日志",
    "❌ GGUF 내보내기 실패: {0} — 아래 로그를 확인하세요",
    "❌ GGUF エクスポートに失敗しました: {0} — 以下のログを参照してください",
    "❌ فشل تصدير GGUF: {0} — راجع السجلات أدناه",
    "❌ Esportazione GGUF fallita: {0} — vedi i log sottostanti"
  ],
  [
    "❤ Likes",
    "❤ 喜欢",
    "❤ 좋아요",
    "❤ いいね",
    "❤ الإعجابات",
    "❤ Mi piace"
  ],
  [
    "➕ Add / download more weights…",
    "➕ 添加 / 下载更多权重…",
    "➕ 가중치 추가 / 다운로드…",
    "➕ 追加 / ウェイトをダウンロード…",
    "➕ إضافة / تنزيل المزيد من الأوزان…",
    "➕ Aggiungi / scarica altri pesi…"
  ],
  [
    "➕ Custom git URL…",
    "➕ 自定义 git URL…",
    "➕ 사용자 지정 git URL…",
    "➕ カスタム git URL…",
    "➕ عنوان URL مخصص من Git…",
    "➕ URL git personalizzato…"
  ],
  [
    "➕ Edit weights",
    "➕ 编辑权重",
    "➕ 가중치 편집",
    "➕ ウェイトを編集",
    "➕ تعديل الأوزان",
    "➕ Modifica pesi"
  ],
  [
    "⟳ Re-check",
    "⟳ 重新检查",
    "⟳ 다시 확인",
    "⟳ 再チェック",
    "⟳ إعادة فحص",
    "⟳ Ricontrolla"
  ],
  [
    "⟳ Restart WSL networking",
    "⟳ 重启 WSL 网络",
    "⟳ WSL 네트워킹 재시작",
    "⟳ WSL ネットワークを再起動",
    "⟳ إعادة تشغيل شبكة WSL",
    "⟳ Riavvia rete WSL"
  ],
  [
    "⟳ Retry",
    "⟳ 重试",
    "⟳ 다시 시도",
    "⟳ 再試行",
    "⟳ إعادة المحاولة",
    "⟳ Riprova"
  ],
  [
    "⤢ open",
    "⤢ 打开",
    "⤢ 열기",
    "⤢ 開く",
    "⤢ فتح",
    "⤢ apri"
  ],
  [
    "⧉ Copy",
    "⧉ 复制",
    "⧉ 복사",
    "⧉ コピー",
    "⧉ نسخ",
    "⧉ Copia"
  ],
  [
    "⬇ Download this model",
    "⬇ 下载此模型",
    "⬇ 이 모델 다운로드",
    "⬇ このモデルをダウンロード",
    "⬇ تنزيل هذا النموذج",
    "⬇ Scarica questo modello"
  ],
  [
    "⬇ Download to this PC",
    "⬇ 下载到此电脑",
    "⬇ 이 PC에 다운로드",
    "⬇ このPCにダウンロード",
    "⬇ التنزيل على هذا الكمبيوتر",
    "⬇ Scarica su questo PC"
  ],
  [
    "⬇ Downloads (",
    "⬇ 下载 (",
    "⬇ 다운로드 (",
    "⬇ ダウンロード (",
    "⬇ التنزيلات (",
    "⬇ Scaricamenti ("
  ],
  [
    "⬇ Install CLI",
    "⬇ 安装 CLI",
    "⬇ CLI 설치",
    "⬇ CLI をインストール",
    "⬇ تثبيت CLI",
    "⬇ Installa CLI"
  ],
  [
    "⬇ Install sandbox engine",
    "⬇ 安装沙盒引擎",
    "⬇ 샌드박스 엔진 설치",
    "⬇ サンドボックスエンジンをインストール",
    "⬇ تثبيت محرك الصندوق الرمل",
    "⬇ Installa motore sandbox"
  ],
  [
    "⬇ Install WSL (admin + reboot)",
    "⬇ 安装 WSL（管理员权限 + 重启）",
    "⬇ WSL 설치 (관리자 권한 + 재부팅)",
    "⬇ WSL をインストール (管理者 + 再起動)",
    "⬇ تثبيت WSL (مسؤول + إعادة تشغيل)",
    "⬇ Installa WSL (admin + riavvio)"
  ],
  [
    "⭐ Recommended",
    "⭐ 推荐",
    "⭐ 추천",
    "⭐ おすすめ",
    "⭐ موصى به",
    "⭐ Consigliato"
  ],
  [
    "⭐ Unsloth",
    "⭐ 不懒惰",
    "⭐ 언슬로스",
    "⭐ アンスロース",
    "⭐ إلغاء الكسل",
    "⭐ Unsloth"
  ],
  [
    "☰ List",
    "☰ 列表",
    "☰ 목록",
    "☰ リスト",
    "☰ قائمة",
    "☰ Elenco"
  ],
  [
    "🌐 Agent Browser",
    "🌐 代理浏览器",
    "🌐 에이전트 브라우저",
    "🌐 エージェントブラウザー",
    "🌐 متصفح الوكيل",
    "🌐 Browser agente"
  ],
  [
    "🌐 Browser",
    "🌐 浏览器",
    "🌐 브라우저",
    "🌐 ブラウザー",
    "🌐 متصفح",
    "🌐 Browser"
  ],
  [
    "🌐 Get key →",
    "🌐 获取密钥 →",
    "🌐 키 받기 →",
    "🌐 キーを取得 →",
    "🌐 الحصول على المفتاح →",
    "🌐 Ottieni chiave →"
  ],
  [
    "🌐 Graph",
    "🌐 图表",
    "🌐 그래프",
    "🌐 グラフ",
    "🌐 الرسم البياني",
    "🌐 Grafico"
  ],
  [
    "🌐 Serve inference on the network (this PC)",
    "🌐 在网络上提供推理（此电脑）",
    "🌐 네트워크에서 추론 제공 (이 PC)",
    "🌐 ネットワークで推論を提供（このPC）",
    "🌐 تقديم الاستدلال على الشبكة (هذا الكمبيوتر)",
    "🌐 Fornisci inferenza sulla rete (questo PC)"
  ],
  [
    "🌐 Translator",
    "🌐 翻译器",
    "🌐 번역기",
    "🌐 翻訳者",
    "🌐 مترجم",
    "🌐 Traduttore"
  ],
  [
    "🌐 Web logins — portal auto-sign-in",
    "🌐 网站登录 — 门户自动登录",
    "🌐 웹 로그인 — 포털 자동 로그인",
    "🌐 ウェブログイン — ポータル自動サインイン",
    "🌐 تسجيلات دخول الويب — تسجيل دخول تلقائي للبوابة",
    "🌐 Accessi web — accesso automatico al portale"
  ],
  [
    "Fine-tune a model",
    "微调模型",
    "모델 파인튜닝",
    "モデルをファインチューニング",
    "تعديل نموذج بدقة",
    "Affina un modello"
  ],
  [
    "🎓 Patient tutor",
    "🎓 耐心导师",
    "🎓 환자 튜터",
    "🎓 忍耐強いチューター",
    "🎓 معلم صبور",
    "🎓 Tutor paziente"
  ],
  [
    "🎨 Design & Visual",
    "🎨 设计与视觉",
    "🎨 디자인 & 비주얼",
    "🎨 デザイン＆ビジュアル",
    "🎨 تصميم وبصري",
    "🎨 Design e Visual"
  ],
  [
    "🎭 Studio",
    "🎭 工作室",
    "🎭 스튜디오",
    "🎭 スタジオ",
    "🎭 استوديو",
    "🎭 Studio"
  ],
  [
    "🎮 Gamify",
    "🎮 游戏化",
    "🎮 게임화",
    "🎮 ゲーミフィケーション",
    "🎮 تحويل إلى لعبة",
    "🎮 Gamifica"
  ],
  [
    "🎮 GPU detail",
    "🎮 GPU 详情",
    "🎮 GPU 상세 정보",
    "🎮 GPUの詳細",
    "🎮 تفاصيل GPU",
    "🎮 Dettagli GPU"
  ],
  [
    "🎯 Train",
    "🎯 训练",
    "🎯 훈련",
    "🎯 トレーニング",
    "🎯 تدريب",
    "🎯 Addestra"
  ],
  [
    "🎯 Tuned Models",
    "🎯 微调模型",
    "🎯 튜닝된 모델",
    "🎯 チューニング済みモデル",
    "🎯 النماذج المعدلة",
    "🎯 Modelli Affinati"
  ],
  [
    "🏋 Full",
    "🏋 完整",
    "🏋 전체",
    "🏋 フル",
    "🏋 كامل",
    "🏋 Pieno"
  ],
  [
    "🏟 Arena",
    "🏟 竞技场",
    "🏟 경기장",
    "🏟 アリーナ",
    "🏟 الساحة",
    "🏟 Arena"
  ],
  [
    "🏠 Home",
    "🏠 主页",
    "🏠 홈",
    "🏠 ホーム",
    "🏠 الصفحة الرئيسية",
    "🏠 Casa"
  ],
  [
    "🏷 Tag",
    "🏷 标签",
    "🏷 태그",
    "🏷 タグ",
    "🏷 وسم",
    "🏷 Etichetta"
  ],
  [
    "🏷 Team",
    "🏷 团队",
    "🏷 팀",
    "🏷 チーム",
    "🏷 فريق",
    "🏷 Squadra"
  ],
  [
    "🐙 Connect GitHub",
    "🐙 连接 GitHub",
    "🐙 GitHub 연결",
    "🐙 GitHubに接続",
    "🐙 ربط GitHub",
    "🐙 Connetti GitHub"
  ],
  [
    "🐙 Connected as",
    "🐙 已连接为",
    "🐙 연결됨:",
    "🐙 接続済み",
    "🐙 متصل باسم",
    "🐙 Connesso come"
  ],
  [
    "🐙 Create GitHub repo + wire origin",
    "🐙 创建 GitHub 仓库并关联源",
    "🐙 GitHub 저장소 생성 + 원격 연결",
    "🐙 GitHubリポジトリを作成してoriginを設定",
    "🐙 إنشاء مستودع GitHub + ربط الأصل",
    "🐙 Crea repo GitHub + collega origine"
  ],
  [
    "🐙 Project created, but the GitHub repo could not be set up: {0} — retry from the Publisher card's ⚙ Set up repo.",
    "🐙 项目已创建，但无法设置 GitHub 仓库：{0} — 请从发布者卡的 ⚙ 设置仓库 重试。",
    "🐙 프로젝트는 생성되었지만 GitHub 저장소를 설정할 수 없습니다: {0} — 게시자 카드의 ⚙ 저장소 설정에서 다시 시도하세요.",
    "🐙 プロジェクトは作成されましたが、GitHubリポジトリを設定できませんでした: {0} — Publisherカードの⚙ リポジトリを設定から再試行してください。",
    "🐙 تم إنشاء المشروع، لكن لم يتمكن من إعداد مستودع GitHub: {0} — أعد المحاولة من بطاقة الناشر ⚙ إعداد المستودع.",
    "🐙 Progetto creato, ma il repo GitHub non può essere configurato: {0} — riprova dalla scheda Publisher in ⚙ Configura repo."
  ],
  [
    "Report this as a bug",
    "报告此问题为错误",
    "버그로 보고",
    "バグとして報告",
    "الإبلاغ عن هذا كخطأ",
    "Segnala questo come bug"
  ],
  [
    "🐧 Fine-tuning Environments",
    "🐧 微调环境",
    "🐧 파인튜닝 환경",
    "🐧 ファインチューニング環境",
    "🐧 بيئات الضبط الدقيق",
    "🐧 Ambienti di Fine-tuning"
  ],
  [
    "🐧 Set up WSL",
    "🐧 设置 WSL",
    "🐧 WSL 설정",
    "🐧 WSLを設定",
    "🐧 إعداد WSL",
    "🐧 Configura WSL"
  ],
  [
    "👁️ Vision",
    "👁️ 视觉",
    "👁️ 비전",
    "👁️ ビジョン",
    "👁️ رؤية",
    "👁️ Visione"
  ],
  [
    "👑 Team Leader",
    "👑 团队负责人",
    "👑 팀 리더",
    "👑 チームリーダー",
    "👑 قائد الفريق",
    "👑 Capo Squadra"
  ],
  [
    "👤 Super User",
    "👤 超级用户",
    "👤 슈퍼 사용자",
    "👤 スーパーユーザー",
    "👤 مستخدم متميز",
    "👤 Super Utente"
  ],
  [
    "👥 {0} · {1} agents",
    "👥 {0} · {1} 个代理",
    "👥 {0} · {1} 에이전트",
    "👥 {0} · {1} エージェント",
    "👥 {0} · {1} وكلاء",
    "👥 {0} · {1} agenti"
  ],
  [
    "👥 Team",
    "👥 团队",
    "👥 팀",
    "👥 チーム",
    "👥 الفريق",
    "👥 Team"
  ],
  [
    "💡 Instruct",
    "💡 指令",
    "💡 지시",
    "💡 指示",
    "💡 التعليمات",
    "💡 Istruzioni"
  ],
  [
    "💡 opportunity",
    "💡 机会",
    "💡 기회",
    "💡 機会",
    "💡 الفرصة",
    "💡 Opportunità"
  ],
  [
    "💤 Idle — run a team on the",
    "💤 空闲 — 运行一个团队在",
    "💤 유휴 — 팀 실행 중",
    "💤 アイドル — チームを実行",
    "💤 خامل — تشغيل فريق على",
    "💤 Inattivo — gestisci un team su"
  ],
  [
    "💬 Chat",
    "💬 聊天",
    "💬 채팅",
    "💬 チャット",
    "💬 الدردشة",
    "💬 Chat"
  ],
  [
    "💬 Type your message:",
    "💬 输入你的消息：",
    "💬 메시지 입력:",
    "💬 メッセージを入力:",
    "💬 اكتب رسالتك:",
    "💬 Digita il tuo messaggio:"
  ],
  [
    "💭 Thinking (",
    "💭 思考 (",
    "💭 생각 중 (",
    "💭 考え中 (",
    "💭 يفكر (",
    "💭 Pensando ("
  ],
  [
    "💻 Code",
    "💻 代码",
    "💻 코드",
    "💻 コード",
    "💻 الشيفرة",
    "💻 Codice"
  ],
  [
    "💻 Coding & Engineering",
    "💻 编码与工程",
    "💻 코딩 및 엔지니어링",
    "💻 コーディング＆エンジニアリング",
    "💻 البرمجة والهندسة",
    "💻 Codifica e Ingegneria"
  ],
  [
    "💻 Coding assistant",
    "💻 编码助手",
    "💻 코딩 어시스턴트",
    "💻 コーディングアシスタント",
    "💻 مساعد البرمجة",
    "💻 Assistente di codifica"
  ],
  [
    "Use a local model",
    "使用本地模型",
    "로컬 모델 사용",
    "ローカルモデルを使用",
    "استخدم نموذج محلي",
    "Usa un modello locale"
  ],
  [
    "💽 Cache",
    "💽 缓存",
    "💽 캐시",
    "💽 キャッシュ",
    "💽 التخزين المؤقت",
    "💽 Cache"
  ],
  [
    "💾 Downloaded",
    "💾 已下载",
    "💾 다운로드됨",
    "💾 ダウンロード済み",
    "💾 تم التحميل",
    "💾 Scaricato"
  ],
  [
    "💾 Sandbox disk",
    "💾 沙盒磁盘",
    "💾 샌드박스 디스크",
    "💾 サンドボックスディスク",
    "💾 قرص الصندوق الرملي",
    "💾 Disco sandbox"
  ],
  [
    "💾 Save",
    "💾 保存",
    "💾 저장",
    "💾 保存",
    "💾 حفظ",
    "💾 Salva"
  ],
  [
    "💾 Save checkpoint",
    "💾 保存检查点",
    "💾 체크포인트 저장",
    "💾 チェックポイントを保存",
    "💾 حفظ نقطة التحقق",
    "💾 Salva checkpoint"
  ],
  [
    "💾 Save JSONL…",
    "💾 保存 JSONL…",
    "💾 JSONL 저장…",
    "💾 JSONLとして保存…",
    "💾 حفظ JSONL…",
    "💾 Salva JSONL…"
  ],
  [
    "💾 Save Node",
    "💾 保存节点",
    "💾 노드 저장",
    "💾 ノードを保存",
    "💾 حفظ العقدة",
    "💾 Salva Nodo"
  ],
  [
    "📁 Browse",
    "📁 浏览",
    "📁 탐색",
    "📁 ブラウズ",
    "📁 تصفح",
    "📁 Sfoglia"
  ],
  [
    "📁 Models",
    "📁 模型",
    "📁 모델",
    "📁 モデル",
    "📁 النماذج",
    "📁 Modelli"
  ],
  [
    "📁 This folder isn't on this device — the project (chat, memory & settings) synced from another machine.",
    "📁 此文件夹不在此设备上 — 项目（聊天、记忆和设置）已从另一台机器同步。",
    "📁 이 폴더는 이 기기에 없습니다 — 프로젝트(채팅, 메모리 및 설정)가 다른 기기에서 동기화되었습니다.",
    "📁 このフォルダーはこのデバイス上にありません — プロジェクト（チャット、メモリ、設定）は別のマシンから同期されています。",
    "📁 هذا المجلد غير موجود على هذا الجهاز — المشروع (الدردشة، الذاكرة والإعدادات) تمت مزامنته من جهاز آخر.",
    "📁 Questa cartella non è su questo dispositivo — il progetto (chat, memoria e impostazioni) è sincronizzato da un altro dispositivo."
  ],
  [
    "📄 Add documents…",
    "📄 添加文档…",
    "📄 문서 추가…",
    "📄 ドキュメントを追加…",
    "📄 إضافة مستندات…",
    "📄 Aggiungi documenti…"
  ],
  [
    "📄 Conversation",
    "📄 对话",
    "📄 대화",
    "📄 会話",
    "📄 المحادثة",
    "📄 Conversazione"
  ],
  [
    "📄 Documents & Content",
    "📄 文档与内容",
    "📄 문서 및 콘텐츠",
    "📄 ドキュメントとコンテンツ",
    "📄 المستندات والمحتوى",
    "📄 Documenti e Contenuti"
  ],
  [
    "📇 Project Card",
    "📇 项目卡片",
    "📇 프로젝트 카드",
    "📇 プロジェクトカード",
    "📇 بطاقة المشروع",
    "📇 Scheda del Progetto"
  ],
  [
    "📉 loss",
    "📉 损失",
    "📉 손실",
    "📉 損失",
    "📉 الخسارة",
    "📉 perdita"
  ],
  [
    "📉 Loss Over Time",
    "📉 损失随时间变化",
    "📉 시간에 따른 손실",
    "📉 時間による損失",
    "📉 الخسارة مع مرور الوقت",
    "📉 Perdita nel Tempo"
  ],
  [
    "📊 Data analyst",
    "📊 数据分析师",
    "📊 데이터 분석가",
    "📊 データアナリスト",
    "📊 محلل البيانات",
    "📊 Analista dei dati"
  ],
  [
    "📊 DATASET",
    "📊 数据集",
    "📊 데이터셋",
    "📊 データセット",
    "📊 مجموعة البيانات",
    "📊 INSIEME DI DATI"
  ],
  [
    "📋 Board",
    "📋 看板",
    "📋 보드",
    "📋 ボード",
    "📋 اللوحة",
    "📋 Bacheca"
  ],
  [
    "📋 Copy",
    "📋 复制",
    "📋 복사",
    "📋 コピー",
    "📋 نسخ",
    "📋 Copia"
  ],
  [
    "📋 Copy API URL",
    "📋 复制 API URL",
    "📋 API URL 복사",
    "📋 API URLをコピー",
    "📋 نسخ رابط واجهة برمجة التطبيقات",
    "📋 Copia URL API"
  ],
  [
    "📋 Copy into workspace",
    "📋 复制到工作区",
    "📋 작업 공간에 복사",
    "📋 ワークスペースにコピー",
    "📋 النسخ إلى مساحة العمل",
    "📋 Copia nello spazio di lavoro"
  ],
  [
    "📋 Copy LAN URL",
    "📋 复制局域网 URL",
    "📋 LAN URL 복사",
    "📋 LAN URLをコピー",
    "📋 نسخ رابط الشبكة المحلية",
    "📋 Copia URL LAN"
  ],
  [
    "📋 Copy Model Name",
    "📋 复制模型名称",
    "📋 모델 이름 복사",
    "📋 モデル名をコピー",
    "📋 نسخ اسم النموذج",
    "📋 Copia Nome Modello"
  ],
  [
    "📋 Instruction Templates",
    "📋 指令模板",
    "📋 지침 템플릿",
    "📋 指示テンプレート",
    "📋 قوالب التعليمات",
    "📋 Modelli di Istruzione"
  ],
  [
    "📋 Plan",
    "📋 计划",
    "📋 계획",
    "📋 計画",
    "📋 الخطة",
    "📋 Piano"
  ],
  [
    "📋 Rules",
    "📋 规则",
    "📋 규칙",
    "📋 ルール",
    "📋 القواعد",
    "📋 Regole"
  ],
  [
    "📋 Server Log",
    "📋 服务器日志",
    "📋 서버 로그",
    "📋 サーバーログ",
    "📋 سجل الخادم",
    "📋 Registro del Server"
  ],
  [
    "📋 Show worklog ({0})",
    "📋 显示工作日志 ({0})",
    "📋 작업 로그 보기 ({0})",
    "📋 作業ログを表示 ({0})",
    "📋 عرض سجل العمل ({0})",
    "📋 Mostra registro lavori ({0})"
  ],
  [
    "📋 Training History",
    "📋 培训历史",
    "📋 훈련 기록",
    "📋 トレーニング履歴",
    "📋 سجل التدريب",
    "📋 Cronologia di Addestramento"
  ],
  [
    "📋 Worklog",
    "📋 工作日志",
    "📋 작업 로그",
    "📋 作業ログ",
    "📋 سجل العمل",
    "📋 Registro Lavori"
  ],
  [
    "📋 Worklog shown — hide",
    "📋 工作日志已显示 — 隐藏",
    "📋 작업 로그 표시 — 숨기기",
    "📋 作業ログ表示 — 隠す",
    "📋 عرض سجل العمل — إخفاء",
    "📋 Registro lavori mostrato — nascondi"
  ],
  [
    "📓 Notebook",
    "📓 笔记本",
    "📓 노트북",
    "📓 ノートブック",
    "📓 دفتر الملاحظات",
    "📓 Taccuino"
  ],
  [
    "📖 Setup Guide",
    "📖 设置指南",
    "📖 설정 가이드",
    "📖 セットアップガイド",
    "📖 دليل الإعداد",
    "📖 Guida all'Installazione"
  ],
  [
    "📚 Dataset",
    "📚 数据集",
    "📚 데이터셋",
    "📚 データセット",
    "📚 مجموعة البيانات",
    "📚 Dataset"
  ],
  [
    "📚 Install skills…",
    "📚 安装技能…",
    "📚 기술 설치…",
    "📚 スキルをインストール…",
    "📚 تثبيت المهارات…",
    "📚 Installa competenze…"
  ],
  [
    "📚 Recommended Models",
    "📚 推荐模型",
    "📚 추천 모델",
    "📚 推奨モデル",
    "📚 النماذج الموصى بها",
    "📚 Modelli Consigliati"
  ],
  [
    "📚 Skill Library",
    "📚 技能库",
    "📚 기술 라이브러리",
    "📚 スキルライブラリ",
    "📚 مكتبة المهارات",
    "📚 Libreria di Competenze"
  ],
  [
    "📚 SKILL.md pack from LLM/data/skills/. Body becomes the system prompt at runtime.",
    "📚 从 LLM/data/skills/ 获取 SKILL.md 包。正文在运行时成为系统提示。",
    "📚 LLM/data/skills/에서 SKILL.md 패키지. 본문은 실행 시 시스템 프롬프트가 됩니다.",
    "📚 LLM/data/skills/ の SKILL.md パック。本文は実行時にシステムプロンプトになります。",
    "📚 حزمة SKILL.md من LLM/data/skills/. يصبح النص الأساسي للنظام أثناء التشغيل.",
    "📚 Pacchetto SKILL.md da LLM/data/skills/. Il corpo diventa il prompt di sistema durante l'esecuzione."
  ],
  [
    "📚 Skills",
    "📚 技能",
    "📚 기술",
    "📚 スキル",
    "📚 المهارات",
    "📚 Competenze"
  ],
  [
    "📚 Skills · loaded on demand",
    "📚 技能 · 按需加载",
    "📚 기술 · 필요에 따라 로드됨",
    "📚 スキル · 要求に応じてロード",
    "📚 المهارات · تم التحميل عند الطلب",
    "📚 Competenze · caricate su richiesta"
  ],
  [
    "📜 About OwLLM",
    "📜 关于 OwLLM",
    "📜 OwLLM 정보",
    "📜 OwLLMについて",
    "📜 حول OwLLM",
    "📜 Informazioni su OwLLM"
  ],
  [
    "📜 Full Chat",
    "📜 完整聊天",
    "📜 전체 채팅",
    "📜 フルチャット",
    "📜 الدردشة الكاملة",
    "📜 Chat completa"
  ],
  [
    "📜 Orchestrator",
    "📜 编排器",
    "📜 오케스트레이터",
    "📜 オーケストレーター",
    "📜 منسق العمليات",
    "📜 Orchestratore"
  ],
  [
    "📜 QUEST BOARD",
    "📜 任务板",
    "📜 퀘스트 보드",
    "📜 クエストボード",
    "📜 لوحة المهام",
    "📜 BACHECA DELLE MISSIONI"
  ],
  [
    "📝 System Prompt",
    "📝 系统提示",
    "📝 시스템 프롬프트",
    "📝 システムプロンプト",
    "📝 موجه النظام",
    "📝 Prompt di sistema"
  ],
  [
    "📡 Share this GPU with my other devices",
    "📡 与我的其他设备共享此 GPU",
    "📡 이 GPU를 다른 기기와 공유",
    "📡 このGPUを他のデバイスと共有する",
    "📡 مشاركة هذه الوحدة الرسومية مع أجهزتي الأخرى",
    "📡 Condividi questa GPU con i miei altri dispositivi"
  ],
  [
    "📤 Send",
    "📤 发送",
    "📤 전송",
    "📤 送信",
    "📤 إرسال",
    "📤 Invia"
  ],
  [
    "📤 Send report",
    "📤 发送报告",
    "📤 보고서 전송",
    "📤 レポートを送信",
    "📤 إرسال التقرير",
    "📤 Invia rapporto"
  ],
  [
    "📥 Download",
    "📥 下载",
    "📥 다운로드",
    "📥 ダウンロード",
    "📥 تنزيل",
    "📥 Scarica"
  ],
  [
    "📥 Download all weights",
    "📥 下载全部权重",
    "📥 모든 가중치 다운로드",
    "📥 すべての重みをダウンロード",
    "📥 تنزيل جميع الأوزان",
    "📥 Scarica tutti i pesi"
  ],
  [
    "📦 Application",
    "📦 应用",
    "📦 애플리케이션",
    "📦 アプリケーション",
    "📦 التطبيق",
    "📦 Applicazione"
  ],
  [
    "📦 Export",
    "📦 导出",
    "📦 내보내기",
    "📦 エクスポート",
    "📦 تصدير",
    "📦 Esporta"
  ],
  [
    "📦 Export GGUF ▾",
    "📦 导出 GGUF ▾",
    "📦 GGUF 내보내기 ▾",
    "📦 GGUFをエクスポート ▾",
    "📦 تصدير GGUF ▾",
    "📦 Esporta GGUF ▾"
  ],
  [
    "📦 Exporting GGUF from {0}…",
    "📦 正在从 {0} 导出 GGUF…",
    "📦 {0}에서 GGUF 내보내는 중…",
    "📦 {0}からGGUFをエクスポート中…",
    "📦 جاري تصدير GGUF من {0}…",
    "📦 Esportazione GGUF da {0}…"
  ],
  [
    "📦 GGUF",
    "📦 GGUF",
    "📦 GGUF",
    "📦 GGUF",
    "📦 GGUF",
    "📦 GGUF"
  ],
  [
    "📦 Models",
    "📦 模型",
    "📦 모델",
    "📦 モデル",
    "📦 النماذج",
    "📦 Modelli"
  ],
  [
    "📦 Other",
    "📦 其他",
    "📦 기타",
    "📦 その他",
    "📦 أخرى",
    "📦 Altro"
  ],
  [
    "📱 Bridge: OFF",
    "📱 桥接：关",
    "📱 브리지: 끔",
    "📱 ブリッジ: オフ",
    "📱 الجسر: إيقاف",
    "📱 Bridge: SPENTO"
  ],
  [
    "📱 Bridge: ON",
    "📱 桥接：开启",
    "📱 브리지: 켜짐",
    "📱 ブリッジ: ON",
    "📱 الجسر: تشغيل",
    "📱 Bridge: ON"
  ],
  [
    "📱 Bridges",
    "📱 桥接",
    "📱 브리지들",
    "📱 ブリッジ",
    "📱 الجسور",
    "📱 Ponti"
  ],
  [
    "Screenshot & ask",
    "截图并提问",
    "스크린샷 & 질문",
    "スクリーンショット & 質問",
    "لقطة شاشة واسأل",
    "Screenshot e chiedi"
  ],
  [
    "🔄 Discover",
    "🔄 发现",
    "🔄 발견",
    "🔄 発見",
    "🔄 اكتشف",
    "🔄 Scopri"
  ],
  [
    "🔄 Models talk to each other",
    "🔄 模型互相交流",
    "🔄 모델 간 대화",
    "🔄 モデル同士で会話",
    "🔄 النماذج تتحدث مع بعضها البعض",
    "🔄 I modelli parlano tra loro"
  ],
  [
    "🔄 Re-propose",
    "🔄 重新提议",
    "🔄 재제안",
    "🔄 再提案",
    "🔄 اقتراح مجدد",
    "🔄 Riproporre"
  ],
  [
    "🔄 Reboot to finish installing WSL",
    "🔄 重启以完成安装 WSL",
    "🔄 WSL 설치 완료를 위해 재부팅",
    "🔄 WSL のインストールを完了するために再起動",
    "🔄 إعادة التشغيل لإنهاء تثبيت WSL",
    "🔄 Riavvia per completare l'installazione di WSL"
  ],
  [
    "🔄 Refresh",
    "🔄 刷新",
    "🔄 새로 고침",
    "🔄 更新",
    "🔄 تحديث",
    "🔄 Aggiorna"
  ],
  [
    "🔄 Refresh Hardware Detection",
    "🔄 刷新硬件检测",
    "🔄 하드웨어 감지 새로 고침",
    "🔄 ハードウェア検出を更新",
    "🔄 تحديث اكتشاف الأجهزة",
    "🔄 Aggiorna rilevamento hardware"
  ],
  [
    "🔄 Reset",
    "🔄 重置",
    "🔄 초기화",
    "🔄 リセット",
    "🔄 إعادة ضبط",
    "🔄 Reset"
  ],
  [
    "🔍 Check",
    "🔍 检查",
    "🔍 확인",
    "🔍 チェック",
    "🔍 فحص",
    "🔍 Controlla"
  ],
  [
    "🔍 Review",
    "🔍 审查",
    "🔍 검토",
    "🔍 レビュー",
    "🔍 مراجعة",
    "🔍 Revisiona"
  ],
  [
    "🔎 Search Results",
    "🔎 搜索结果",
    "🔎 검색 결과",
    "🔎 検索結果",
    "🔎 نتائج البحث",
    "🔎 Risultati della ricerca"
  ],
  [
    "🔐 Accounts",
    "🔐 账户",
    "🔐 계정",
    "🔐 アカウント",
    "🔐 الحسابات",
    "🔐 Account"
  ],
  [
    "🔑 Brave Search key required (set in Accounts page)",
    "🔑 需要 Brave 搜索密钥（在账户页面设置）",
    "🔑 브레이브 검색 키 필요 (계정 페이지에서 설정)",
    "🔑 Brave Search キーが必要（アカウントページで設定）",
    "🔑 مفتاح Brave Search مطلوب (يتم تعيينه في صفحة الحسابات)",
    "🔑 Chiave Brave Search richiesta (impostata nella pagina Account)"
  ],
  [
    "🔑 Required credentials",
    "🔑 所需凭证",
    "🔑 필요 자격 증명",
    "🔑 必要な認証情報",
    "🔑 بيانات الاعتماد المطلوبة",
    "🔑 Credenziali richieste"
  ],
  [
    "🔑 Sync logins",
    "🔑 同步登录",
    "🔑 로그인 동기화",
    "🔑 ログイン情報を同期",
    "🔑 مزامنة تسجيلات الدخول",
    "🔑 Sincronizza accessi"
  ],
  [
    "🔑 Synced cloud logins into the sandbox: {0}.",
    "🔑 已将云登录同步到沙箱：{0}。",
    "🔑 샌드박스에 클라우드 로그인 동기화: {0}.",
    "🔑 サンドボックスにクラウドログインを同期しました: {0}。",
    "🔑 تم مزامنة تسجيلات الدخول السحابية في الصندوق الرملي: {0}.",
    "🔑 Accessi cloud sincronizzati nella sandbox: {0}."
  ],
  [
    "🔒 Built-in role from LLM/core/agents/roles/. Click",
    "🔒 来自 LLM/core/agents/roles/ 的内置角色。点击",
    "🔒 LLM/core/agents/roles/에 있는 내장 역할. 클릭",
    "🔒 LLM/core/agents/roles/から組み込みの役割を構築しました。クリック",
    "🔒 دور مدمج من LLM/core/agents/roles/. انقر",
    "🔒 Ruolo integrato da LLM/core/agents/roles/. Clicca"
  ],
  [
    "🔒 File outside the workspace",
    "🔒 工作区外的文件",
    "🔒 작업 공간 외부의 파일",
    "🔒 ワークスペース外のファイル",
    "🔒 ملف خارج مساحة العمل",
    "🔒 File fuori dall'area di lavoro"
  ],
  [
    "🔒 password saved",
    "🔒 密码已保存",
    "🔒 비밀번호 저장됨",
    "🔒 パスワードが保存されました",
    "🔒 تم حفظ كلمة المرور",
    "🔒 password salvata"
  ],
  [
    "🔓 Full access…",
    "🔓 完全访问…",
    "🔓 전체 접근…",
    "🔓 フルアクセス…",
    "🔓 وصول كامل…",
    "🔓 Accesso completo…"
  ],
  [
    "🔓 Grant home (this run)",
    "🔓 授予主目录（本次运行）",
    "🔓 홈 권한 부여 (이번 실행)",
    "🔓 ホームを付与（この実行時）",
    "🔓 منح الوصول إلى الصفحة الرئيسية (هذه الجلسة)",
    "🔓 Concedi home (questa esecuzione)"
  ],
  [
    "🔗 Open on huggingface.co",
    "🔗 在 huggingface.co 上打开",
    "🔗 huggingface.co에서 열기",
    "🔗 huggingface.coで開く",
    "🔗 افتح على huggingface.co",
    "🔗 Apri su huggingface.co"
  ],
  [
    "🔗 Sign in with GitHub",
    "🔗 使用 GitHub 登录",
    "🔗 GitHub로 로그인",
    "🔗 GitHubでサインイン",
    "🔗 تسجيل الدخول باستخدام GitHub",
    "🔗 Accedi con GitHub"
  ],
  [
    "🔧 Repair now (reinstall, matched to your hardware)",
    "🔧 立即修复（重新安装，匹配您的硬件）",
    "🔧 지금 수리 (재설치, 하드웨어에 맞춤)",
    "🔧 今すぐ修復（再インストール、あなたのハードウェアに合わせて）",
    "🔧 إصلاح الآن (إعادة التثبيت، متوافق مع جهازك)",
    "🔧 Ripara ora (reinstalla, adattato al tuo hardware)"
  ],
  [
    "🔬 Run secure self-test",
    "🔬 运行安全自检",
    "🔬 안전한 자기 테스트 실행",
    "🔬 安全なセルフテストを実行",
    "🔬 تشغيل الاختبار الذاتي الآمن",
    "🔬 Esegui auto-test sicuro"
  ],
  [
    "🕓 Uploaded",
    "🕓 已上传",
    "🕓 업로드됨",
    "🕓 アップロード済み",
    "🕓 تم التحميل",
    "🕓 Caricato"
  ],
  [
    "🕘 History",
    "🕘 历史记录",
    "🕘 기록",
    "🕘 履歴",
    "🕘 السجل",
    "🕘 Cronologia"
  ],
  [
    "🖊 Signing",
    "🖊 签名中",
    "🖊 서명 중",
    "🖊 署名中",
    "🖊 التوقيع",
    "🖊 Firmando"
  ],
  [
    "🖊 Signing & credentials",
    "🖊 签名与凭证",
    "🖊 서명 및 자격 증명",
    "🖊 署名と資格情報",
    "🖊 التوقيع والمعلومات الاعتمادية",
    "🖊 Firma e credenziali"
  ],
  [
    "🖥 Devices",
    "🖥 设备",
    "🖥 장치",
    "🖥 デバイス",
    "🖥 الأجهزة",
    "🖥 Dispositivi"
  ],
  [
    "🖥 Hardware",
    "🖥 硬件",
    "🖥 하드웨어",
    "🖥 ハードウェア",
    "🖥 الأجهزة الصلبة",
    "🖥 Hardware"
  ],
  [
    "🖥 Open shell",
    "🖥 打开终端",
    "🖥 오픈 셸",
    "🖥 シェルを開く",
    "🖥 فتح الصدفة",
    "🖥 Apri shell"
  ],
  [
    "🖥 Remote Devices",
    "🖥 远程设备",
    "🖥 원격 장치",
    "🖥 リモートデバイス",
    "🖥 أجهزة عن بُعد",
    "🖥 Dispositivi remoti"
  ],
  [
    "🖥 Terminal",
    "🖥 终端",
    "🖥 터미널",
    "🖥 ターミナル",
    "🖥 الطرفية",
    "🖥 Terminale"
  ],
  [
    "🖥 Terminal —",
    "🖥 终端 —",
    "🖥 터미널 —",
    "🖥 ターミナル —",
    "🖥 الطرفية —",
    "🖥 Terminale —"
  ],
  [
    "🖥🔌 OWLLM Node — KVM remote control",
    "🖥🔌 OWLLM 节点 — KVM 远程控制",
    "🖥🔌 OWLLM 노드 — KVM 원격 제어",
    "🖥🔌 OWLLM ノード — KVM リモートコントロール",
    "🖥🔌 عقدة OWLLM — التحكم عن بُعد KVM",
    "🖥🔌 Nodo OWLLM — Controllo remoto KVM"
  ],
  [
    "🖧 Server",
    "🖧 服务器",
    "🖧 서버",
    "🖧 サーバー",
    "🖧 الخادم",
    "🖧 Server"
  ],
  [
    "🖧 Server Control",
    "🖧 服务器控制",
    "🖧 서버 제어",
    "🖧 サーバーコントロール",
    "🖧 التحكم في الخادم",
    "🖧 Controllo server"
  ],
  [
    "🖧 Servers",
    "🖧 服务器们",
    "🖧 서버들",
    "🖧 サーバー",
    "🖧 الخوادم",
    "🖧 Server"
  ],
  [
    "🖼 Assets",
    "🖼 资产",
    "🖼 자산",
    "🖼 アセット",
    "🖼 الأصول",
    "🖼 Risorse"
  ],
  [
    "🖼 Media Assets",
    "🖼 媒体资产",
    "🖼 미디어 자산",
    "🖼 メディアアセット",
    "🖼 الأصول الإعلامية",
    "🖼 Risorse multimediali"
  ],
  [
    "🗑️ Clear",
    "🗑️ 清除",
    "🗑️ 지우기",
    "🗑️ クリア",
    "🗑️ مسح",
    "🗑️ Cancella"
  ],
  [
    "🗑️ Clear Log",
    "🗑️ 清除日志",
    "🗑️ 로그 지우기",
    "🗑️ ログをクリア",
    "🗑️ مسح السجل",
    "🗑️ Cancella registro"
  ],
  [
    "🗑️ Delete",
    "🗑️ 删除",
    "🗑️ 삭제",
    "🗑️ 削除",
    "🗑️ حذف",
    "🗑️ Elimina"
  ],
  [
    "🗑 Delete project…",
    "🗑 删除项目…",
    "🗑 프로젝트 삭제…",
    "🗑 プロジェクトを削除…",
    "🗑 حذف المشروع…",
    "🗑 Elimina progetto…"
  ],
  [
    "🗑️ Delete selected",
    "🗑️ 删除所选",
    "🗑️ 선택 항목 삭제",
    "🗑️ 選択項目を削除",
    "🗑️ حذف المحدد",
    "🗑️ Elimina selezionato"
  ],
  [
    "🗑️ Deleting {0}…",
    "🗑️ 正在删除 {0}…",
    "🗑️ {0} 삭제 중…",
    "🗑️ {0} を削除中…",
    "🗑️ جاري حذف {0}…",
    "🗑️ Eliminazione di {0}…"
  ],
  [
    "🗑 Remove",
    "🗑 移除",
    "🗑 제거",
    "🗑 削除",
    "🗑 إزالة",
    "🗑 Rimuovi"
  ],
  [
    "🤖 Agents",
    "🤖 代理",
    "🤖 에이전트",
    "🤖 エージェント",
    "🤖 الوكلاء",
    "🤖 Agenti"
  ],
  [
    "🤖 BASE MODEL",
    "🤖 基础模型",
    "🤖 기본 모델",
    "🤖 基本モデル",
    "🤖 النموذج الأساسي",
    "🤖 MODELLO BASE"
  ],
  [
    "🤖 Helpful assistant",
    "🤖 有用的助手",
    "🤖 유용한 조수",
    "🤖 役に立つアシスタント",
    "🤖 مساعد مفيد",
    "🤖 Assistente utile"
  ],
  [
    "🤖 LLM Inference Server",
    "🤖 大语言模型推理服务器",
    "🤖 LLM 추론 서버",
    "🤖 LLM 推論サーバー",
    "🤖 خادم استنتاج النماذج الكبيرة",
    "🤖 Server di inferenza LLM"
  ],
  [
    "🤝 Assemble team from brief",
    "🤝 从简介组建团队",
    "🤝 브리프에서 팀 구성",
    "🤝 ブリーフからチームを編成",
    "🤝 تجميع الفريق من الملخص",
    "🤝 Assembla il team dal brief"
  ],
  [
    "🤝 Assembling team…",
    "🤝 正在组建团队…",
    "🤝 팀 구성 중…",
    "🤝 チームを編成中…",
    "🤝 جاري تجميع الفريق…",
    "🤝 Assemblando il team…"
  ],
  [
    "🦙 Install LLM engine",
    "🦙 安装大语言模型引擎",
    "🦙 LLM 엔진 설치",
    "🦙 LLM エンジンをインストール",
    "🦙 تثبيت محرك النماذج الكبيرة",
    "🦙 Installa motore LLM"
  ],
  [
    "🦙 Model server",
    "🦙 模型服务器",
    "🦙 모델 서버",
    "🦙 モデルサーバー",
    "🦙 خادم النماذج",
    "🦙 Server modello"
  ],
  [
    "🧙‍♂️ Characters",
    "🧙‍♂️ 角色",
    "🧙‍♂️ 캐릭터",
    "🧙‍♂️ キャラクター",
    "🧙‍♂️ الشخصيات",
    "🧙‍♂️ Personaggi"
  ],
  [
    "🧠 Fact",
    "🧠 事实",
    "🧠 사실",
    "🧠 事実",
    "🧠 حقيقة",
    "🧠 Fatti"
  ],
  [
    "🧠 Memory",
    "🧠 记忆",
    "🧠 기억",
    "🧠 メモリ",
    "🧠 ذاكرة",
    "🧠 Memoria"
  ],
  [
    "🧠 Reasoning",
    "🧠 推理",
    "🧠 추론",
    "🧠 推論",
    "🧠 استدلال",
    "🧠 Ragionamento"
  ],
  [
    "🧠 Thought",
    "🧠 思考",
    "🧠 사고",
    "🧠 思考",
    "🧠 فكرة",
    "🧠 Pensiero"
  ],
  [
    "Agentic workflow",
    "代理工作流",
    "에이전트 워크플로우",
    "エージェンシー ワークフロー",
    "سير عمل وكيل",
    "Flusso di lavoro agentico"
  ],
  [
    "🧩 LoRA",
    "🧩 LoRA",
    "🧩 LoRA",
    "🧩 LoRA",
    "🧩 لورا",
    "🧩 LoRA"
  ],
  [
    "🧩 MCP",
    "🧩 MCP",
    "🧩 MCP",
    "🧩 MCP",
    "🧩 MCP",
    "🧩 MCP"
  ],
  [
    "🧩 MCP Servers",
    "🧩 MCP 服务器",
    "🧩 MCP 서버",
    "🧩 MCP サーバー",
    "🧩 خوادم MCP",
    "🧩 Server MCP"
  ],
  [
    "🧩 Teams",
    "🧩 团队",
    "🧩 팀",
    "🧩 チーム",
    "🧩 الفرق",
    "🧩 Team"
  ],
  [
    "🧭 Orchestration & Planning",
    "🧭 编排与规划",
    "🧭 오케스트레이션 및 계획",
    "🧭 オーケストレーションと計画",
    "🧭 التنسيق والتخطيط",
    "🧭 Orchestrazione e Pianificazione"
  ],
  [
    "🧹 Deleting {0} cache/trash item(s)…",
    "🧹 正在删除 {0} 个缓存/垃圾项目…",
    "🧹 {0} 캐시/휴지통 항목 삭제 중…",
    "🧹 {0} 件のキャッシュ/ゴミアイテムを削除中…",
    "🧹 جاري حذف {0} من عناصر التخزين المؤقت/القمامة…",
    "🧹 Eliminazione di {0} elemento/i cache/spazzatura…"
  ],
  [
    "🧹 Deleting {0}/{1}: {2} ({3})",
    "🧹 正在删除 {0}/{1}：{2} ({3})",
    "🧹 {0}/{1} 삭제 중: {2} ({3})",
    "🧹 {0}/{1} を削除中: {2} ({3})",
    "🧹 جاري حذف {0}/{1}: {2} ({3})",
    "🧹 Eliminazione di {0}/{1}: {2} ({3})"
  ],
  [
    "🩺 Diagnose",
    "🩺 诊断",
    "🩺 진단",
    "🩺 診断",
    "🩺 التشخيص",
    "🩺 Diagnosi"
  ],
  [
    "Digest notes",
    "消化笔记",
    "노트 요약",
    "ノートの要約",
    "تلخيص الملاحظات",
    "Digest note"
  ],
  [
    "🪶 LoRA",
    "🪶 LoRA",
    "🪶 LoRA",
    "🪶 LoRA",
    "🪶 LoRA",
    "🪶 LoRA"
  ],
  [
    "🚀 Browse Models",
    "🚀 浏览模型",
    "🚀 모델 탐색",
    "🚀 モデルを閲覧",
    "🚀 تصفح النماذج",
    "🚀 Sfoglia Modelli"
  ],
  [
    "🚀 Finish download",
    "🚀 下载完成",
    "🚀 다운로드 완료",
    "🚀 ダウンロード完了",
    "🚀 إنهاء التحميل",
    "🚀 Termina download"
  ],
  [
    "🚀 Get a token from Hugging Face →",
    "🚀 从 Hugging Face 获取令牌 →",
    "🚀 Hugging Face에서 토큰 얻기 →",
    "🚀 Hugging Face からトークンを取得 →",
    "🚀 الحصول على رمز من Hugging Face →",
    "🚀 Ottieni un token da Hugging Face →"
  ],
  [
    "🚀 Start brainstorm",
    "🚀 开始头脑风暴",
    "🚀 브레인스토밍 시작",
    "🚀 ブレインストーム開始",
    "🚀 بدء جلسة العصف الذهني",
    "🚀 Inizia brainstorming"
  ],
  [
    "🚀 START TRAINING",
    "🚀 开始训练",
    "🚀 학습 시작",
    "🚀 トレーニング開始",
    "🚀 بدء التدريب",
    "🚀 INIZIA AD ALLENARE"
  ],
  [
    "🚀 Starting…",
    "🚀 正在启动…",
    "🚀 시작 중…",
    "🚀 開始中…",
    "🚀 جاري البدء…",
    "🚀 Avvio in corso…"
  ],
  [
    "🚂 TRAINING DASHBOARD",
    "🚂 训练仪表板",
    "🚂 학습 대시보드",
    "🚂 トレーニングダッシュボード",
    "🚂 لوحة تحكم التدريب",
    "🚂 CRUSCOTTO DI ALLENAMENTO"
  ],
  [
    "🚧 Under Construction 🚧",
    "🚧 正在建设中 🚧",
    "🚧 공사 중 🚧",
    "🚧 工事中 🚧",
    "🚧 قيد الإنشاء 🚧",
    "🚧 In costruzione 🚧"
  ],
  [
    "🚫 0 dispatches parsed — orchestrator answered solo, and this team has no specialist to route to. Add a specialist or rephrase the goal.",
    "🚫 解析了 0 个调度 — 协调器单独回答，本团队没有可路由的专家。添加专家或重新表述目标。",
    "🚫 0개의 디스패치 파싱 — 오케스트레이터가 단독으로 응답했으며 이 팀에는 라우팅할 전문가가 없습니다. 전문가를 추가하거나 목표를 다시 표현하세요.",
    "🚫 0 件のディスパッチが解析されました — オーケストレーターが単独で応答し、このチームにはルーティングする専門家がいません。専門家を追加するか目標を言い換えてください。",
    "🚫 تم تحليل 0 إرساليات — أجاب المنسق بمفرده، وليس لدى هذا الفريق أخصائي لتحويل المهمة إليه. أضف أخصائيًا أو أعد صياغة الهدف.",
    "🚫 0 spedizioni elaborate — l'orchestratore ha risposto da solo e questo team non ha uno specialista a cui indirizzare. Aggiungi uno specialista o riformula l'obiettivo."
  ],
  [
    "🚫 0 dispatches ran — the orchestrator named agents that don't exist ({0}) and there's no specialist to fall back to.",
    "🚫 0 个派遣已运行——协调器指定了不存在的代理 ({0})，且没有可依赖的专家。",
    "🚫 0개의 디스패치가 실행되었습니다 — 오케스트레이터가 존재하지 않는 에이전트({0})를 지정했고, 의지할 수 있는 전문가가 없습니다.",
    "🚫 0件のディスパッチが実行されました — オーケストレーターが存在しないエージェントを指定しました（{0}）が、代わりに対応できるスペシャリストがいません。 ",
    "🚫 لم يتم تشغيل أي عملية إرسال — قام المنسق بتسمية وكلاء غير موجودين ({0}) ولا يوجد متخصص للرجوع إليه.",
    "🚫 0 invii eseguiti — l'orchestratore ha nominato agenti che non esistono ({0}) e non c'è uno specialista a cui fare riferimento."
  ],
  [
    "🚫 ABLITERATE",
    "🚫 消灭",
    "🚫 전멸",
    "🚫 消滅 ",
    "🚫 ابادة",
    "🚫 ABOLIRE"
  ],
  [
    "Abliterate a model",
    "消灭一个模型",
    "모델 전멸",
    "モデルを消滅させる ",
    "ابادة نموذج",
    "Abolire un modello"
  ],
  [
    "🚫 Abliterate model",
    "🚫 消灭模型",
    "🚫 모델 전멸",
    "🚫 モデルを消滅 ",
    "🚫 ابادة النموذج",
    "🚫 Abolire modello"
  ],
  [
    "🚫 Abliterated",
    "🚫 已消灭",
    "🚫 전멸됨",
    "🚫 消滅しました ",
    "🚫 تم الابادة",
    "🚫 Abolito"
  ],
  [
    "🚫 What is abliteration?",
    "🚫 什么是消灭？",
    "🚫 전멸이란 무엇인가요?",
    "🚫 消滅とは何ですか？ ",
    "🚫 ما هي الابادة؟",
    "🚫 Cos'è l'abolizione?"
  ],
  [
    "🛠️ Env",
    "🛠️ 环境",
    "🛠️ 환경",
    "🛠️ 環境 ",
    "🛠️ بيئة",
    "🛠️ Ambiente"
  ],
  [
    "🛠 Install uv runtime (one-click, ~30 MB)",
    "🛠 安装 uv 运行时（一键，约 30 MB）",
    "🛠 UV 런타임 설치 (원클릭, 약 30 MB)",
    "🛠 uvランタイムをインストール（一括、約30 MB） ",
    "🛠 تثبيت وقت تشغيل uv (بنقرة واحدة، ~30 ميجابايت)",
    "🛠 Installare runtime uv (con un clic, ~30 MB)"
  ],
  [
    "🛠️ OWLLM MCP",
    "🛠️ OWLLM MCP",
    "🛠️ OWLLM MCP",
    "🛠️ OWLLM MCP ",
    "🛠️ OWLLM MCP",
    "🛠️ OWLLM MCP"
  ],
  [
    "🛠️ Set up Fine-tuning Environment",
    "🛠️ 设置微调环境",
    "🛠️ 파인튜닝 환경 설정",
    "🛠️ ファインチューニング環境を設定 ",
    "🛠️ إعداد بيئة التخصيص الدقيق",
    "🛠️ Configurare l'ambiente di fine-tuning"
  ],
  [
    "🛠 Tool Calls",
    "🛠 工具调用",
    "🛠 도구 호출",
    "🛠 ツールコール ",
    "🛠 مكالمات الأدوات",
    "🛠 Chiamate agli strumenti"
  ],
  [
    "🛡 Isolation on — projects run inside {0}{1}, off your {2} files.{3}",
    "🛡 隔离开启——项目在 {0}{1} 内运行，离开你的 {2} 文件。{3}",
    "🛡 격리 켬 — 프로젝트가 {0}{1} 안에서 실행되며, {2} 파일에는 영향을 주지 않습니다.{3}",
    "🛡 分離オン — プロジェクトは{0}{1}内で実行され、あなたの{2}ファイルには影響しません。{3} ",
    "🛡 العزل مفعل — المشاريع تعمل داخل {0}{1}، بعيدًا عن ملفات {2}.{3}",
    "🛡 Isolamento attivo — i progetti vengono eseguiti all'interno di {0}{1}, separati dai tuoi file {2}.{3}"
  ],
  [
    "🛡 New project",
    "🛡 新项目",
    "🛡 새 프로젝트",
    "🛡 新しいプロジェクト ",
    "🛡 مشروع جديد",
    "🛡 Nuovo progetto"
  ],
  [
    "🛡 Run isolated",
    "🛡 运行隔离",
    "🛡 격리 실행",
    "🛡 分離環境で実行",
    "🛡 تشغيل معزول",
    "🛡 Esegui isolato"
  ],
  [
    "🛰 Inference source",
    "🛰 推理来源",
    "🛰 추론 소스",
    "🛰 推論ソース",
    "🛰 مصدر الاستدلال",
    "🛰 Fonte di inferenza"
  ],
  [
    "🟡 v2 — later",
    "🟡 v2 — 后续",
    "🟡 v2 — 이후",
    "🟡 v2 — 後期",
    "🟡 الإصدار 2 — لاحقًا",
    "🟡 v2 — successivo"
  ],
  [
    "🟢 Live run —",
    "🟢 实时运行 —",
    "🟢 라이브 실행 —",
    "🟢 ライブ実行 —",
    "🟢 التشغيل الحي —",
    "🟢 Esecuzione live —"
  ],
  [
    "🟢 MCP tools ON",
    "🟢 MCP 工具开启",
    "🟢 MCP 도구 켬",
    "🟢 MCPツール ON",
    "🟢 أدوات MCP مفعلة",
    "🟢 Strumenti MCP ATTIVI"
  ],
  [
    "🟢 Running",
    "🟢 正在运行",
    "🟢 실행 중",
    "🟢 実行中",
    "🟢 جارٍ التشغيل",
    "🟢 In esecuzione"
  ],
  [
    "🟢 Servers: 0",
    "🟢 服务器：0",
    "🟢 서버: 0",
    "🟢 サーバー: 0",
    "🟢 الخوادم: 0",
    "🟢 Server: 0"
  ],
  [
    "🟢 Servers: 1 ({0})",
    "🟢 服务器：1 ({0})",
    "🟢 서버: 1 ({0})",
    "🟢 サーバー: 1 ({0})",
    "🟢 الخوادم: 1 ({0})",
    "🟢 Server: 1 ({0})"
  ],
  [
    "🟢 v1 — must have",
    "🟢 v1 — 必须有",
    "🟢 v1 — 필수",
    "🟢 v1 — 必須",
    "🟢 الإصدار 1 — ضروري",
    "🟢 v1 — indispensabile"
  ],
  [
    "① Create a token on GitHub →",
    "① 在 GitHub 上创建一个令牌 →",
    "① GitHub에서 토큰 생성 →",
    "① GitHubでトークンを作成 →",
    "① إنشاء رمز على GitHub →",
    "① Crea un token su GitHub →"
  ],
  [
    "1-3B model: ~3-8 min",
    "1-3B 模型：约 3-8 分钟",
    "1-3B 모델: 약 3-8분",
    "1-3Bモデル: 約3-8分",
    "نموذج 1-3B: ~3-8 دقائق",
    "Modello 1-3B: ~3-8 min"
  ],
  [
    "1. We opened",
    "1. 我们打开了",
    "1. 열었습니다",
    "1. 開きました",
    "1. فتحنا",
    "1. Abbiamo aperto"
  ],
  [
    "10-char team id",
    "10 位字符的团队 ID",
    "10자리 팀 ID",
    "10文字のチームID",
    "معرف الفريق المكون من 10 أحرف",
    "ID team di 10 caratteri"
  ],
  [
    "123456:ABCdefGhi…",
    "123456:ABCdefGhi…",
    "123456:ABCdefGhi…",
    "123456:ABCdefGhi…",
    "123456:ABCdefGhi…",
    "123456:ABCdefGhi…"
  ],
  [
    "13B+ model: 30-60+ min (depends on VRAM headroom for fp16 forward passes)",
    "13B+ 模型：30-60 分钟以上（取决于 fp16 前向传递的 VRAM 余量）",
    "13B+ 모델: 30-60분 이상 (fp16 순방향 패스용 VRAM 여유 공간에 따라 다름)",
    "13B+モデル: 30-60分以上（fp16フォワードパスのためのVRAM余裕に依存）",
    "نموذج 13B+: 30-60+ دقيقة (يعتمد على مساحة VRAM المتاحة لتمريرات fp16 الأمامية)",
    "Modello 13B+: 30-60+ min (dipende dalla memoria VRAM disponibile per passaggi forward fp16)"
  ],
  [
    "② Paste the token here (ghp_…)",
    "② 将令牌粘贴在这里 (ghp_…)",
    "② 토큰을 여기에 붙여넣기 (ghp_…)",
    "② ここにトークンを貼り付ける (ghp_…)",
    "② لصق الرمز هنا (ghp_…)",
    "② Incolla il token qui (ghp_…)"
  ],
  [
    "2. Sign in (or",
    "2. 登录（或",
    "2. 로그인 (또는",
    "2. サインイン（または",
    "2. تسجيل الدخول (أو",
    "2. Accedi (o"
  ],
  [
    "3D knowledge graph of the team memory",
    "团队记忆的 3D 知识图",
    "팀 메모리의 3D 지식 그래프",
    "チームメモリの3Dナレッジグラフ",
    "رسم بياني معرفي ثلاثي الأبعاد لذاكرة الفريق",
    "Grafico della conoscenza 3D della memoria del team"
  ],
  [
    "5px 10px 0",
    "5px 10px 0",
    "5px 10px 0",
    "5px 10px 0",
    "5px 10px 0",
    "5px 10px 0"
  ],
  [
    "7-8B model: ~10-20 min",
    "7-8B 模型：约 10-20 分钟",
    "7-8B 모델: 약 10-20분",
    "7-8Bモデル: 約10〜20分",
    "نموذج 7-8B: ~10-20 دقيقة",
    "Modello 7-8B: ~10-20 min"
  ],
  [
    "a folder you pick",
    "您选择的文件夹",
    "선택한 폴더",
    "選んだフォルダ",
    "مجلد تختاره",
    "una cartella che scegli"
  ],
  [
    "a Linux sandbox",
    "一个 Linux 沙箱",
    "리눅스 샌드박스",
    "Linuxサンドボックス",
    "صندوق رمل لينكس",
    "un ambiente Linux isolato"
  ],
  [
    "a local model (server not running)",
    "本地模型（服务器未运行）",
    "로컬 모델(서버 실행 중 아님)",
    "ローカルモデル（サーバー未起動）",
    "نموذج محلي (الخادم غير شغال)",
    "un modello locale (server non in esecuzione)"
  ],
  [
    "A private git worktree is being checked out (a few seconds on a large repo). Your real folder stays untouched until you Merge. You can type your request now — Send unlocks the moment it's ready.",
    "正在签出一个私有 git 工作树（在大型仓库上需要几秒钟）。在你合并之前，你的真实文件夹保持不变。你现在可以输入你的请求——发送将在准备好时立即解锁。",
    "개인 git 작업 트리가 체크아웃되고 있습니다(대형 저장소에서는 몇 초 소요될 수 있음). 실제 폴더는 병합할 때까지 변경되지 않습니다. 지금 요청을 입력할 수 있습니다 — 준비되는 즉시 보내기가 잠금을 해제합니다.",
    "プライベートな git ワークツリーがチェックアウトされています（大きなリポジトリでは数秒かかります）。実際のフォルダはマージするまで触れられません。今すぐリクエストを入力できます — 送信は準備ができた瞬間にロック解除されます。",
    "يتم حالياً استخراج شجرة العمل الخاصة بـ git (بضع ثوانٍ على مستودع كبير). يظل مجلدك الحقيقي دون تغيير حتى تقوم بالدمج. يمكنك كتابة طلبك الآن — الإرسال يفتح القفل فور جاهزيته.",
    "Si sta controllando un worktree git privato (pochi secondi su un repository grande). La tua cartella reale rimane intatta fino a quando non fai Merge. Puoi digitare la tua richiesta ora — Invia sblocca nel momento in cui è pronta."
  ],
  [
    "A project couples a folder, a roster of agents, and the team's wiring. The orchestrator dispatches against this roster when you click Run on the Agents tab.",
    "一个项目关联一个文件夹、一个代理列表和团队的连接配置。当你在代理选项卡上点击运行时，编排器会根据这个列表进行调度。",
    "프로젝트는 폴더, 에이전트 명단, 팀 구성 요소를 결합합니다. 오케스트레이터는 에이전트 탭에서 실행(Run)을 클릭할 때 이 명단을 기반으로 디스패치합니다.",
    "プロジェクトはフォルダ、エージェントの名簿、チームの配線を結びつけます。オーケストレーターは、AgentsタブでRunをクリックするとこの名簿に対してタスクを送ります。",
    "المشروع يربط مجلدًا، وقائمة بالوكلاء، وأسلاك الفريق. الموجه يرسل المهام وفقًا لهذه القائمة عند النقر على تشغيل في تبويب الوكلاء.",
    "Un progetto collega una cartella, un elenco di agenti e il cablaggio del team. L'orchestratore invia ai membri di questo elenco quando clicchi Esegui nella scheda Agenti."
  ],
  [
    "A read-only token unlocks gated models (Llama, Gemma, some Mistral) and lifts anon rate limits. Public models work without it.",
    "只读令牌可以解锁受限制的模型（Llama、Gemma、一些 Mistral）并取消匿名速率限制。公共模型无需此令牌即可使用。",
    "읽기 전용 토큰은 제한된 모델(Llama, Gemma, 일부 Mistral)을 잠금 해제하고 익명 속도 제한을 해제합니다. 공개 모델은 토큰 없이도 작동합니다.",
    "読み取り専用トークンは、制限付きモデル（Llama、Gemma、一部Mistral）を解放し、匿名のレート制限を解除します。パブリックモデルはそれなしでも動作します。",
    "تفتح رمز مميز للقراءة فقط النماذج المقيدة (Llama و Gemma وبعض Mistral) وتزيل حدود المعدل للزوار المجهولين. النماذج العامة تعمل بدونه.",
    "Un token solo-lettura sblocca modelli protetti (Llama, Gemma, alcuni Mistral) e rimuove i limiti anonimi di velocità. I modelli pubblici funzionano senza di esso."
  ],
  [
    "a real shell on the remote machine — type into it",
    "远程机器上的真实 shell — 输入命令",
    "원격 머신에서 실제 셸 — 그 안에 입력하세요",
    "リモートマシン上の実際のシェル — そこに入力してください",
    "صدفة حقيقية على الجهاز البعيد — اكتب فيها",
    "una vera shell sulla macchina remota — digita al suo interno"
  ],
  [
    "A signing key already exists here. Generating a new request replaces it — a .cer issued for the OLD request can then no longer be imported. Continue?",
    "此处已存在签名密钥。生成新请求将替换它 — 为旧请求签发的 .cer 将无法再导入。是否继续？",
    "여기에 이미 서명 키가 존재합니다. 새 요청을 생성하면 기존 키가 교체됩니다 — 이전 요청으로 발급된 .cer 파일은 더 이상 가져올 수 없습니다. 계속하시겠습니까?",
    "署名キーは既に存在します。新しいリクエストを作成すると置き換えられます — 以前のリクエストで発行された.cerはその後インポートできなくなります。続行しますか？",
    "مفتاح توقيع موجود بالفعل هنا. إنشاء طلب جديد يستبدله — لا يمكن بعد ذلك استيراد ملف .cer الصادر للطلب القديم. هل تريد المتابعة؟",
    "Qui esiste già una chiave di firma. Generare una nuova richiesta la sostituisce — un .cer emesso per la VECCHIA richiesta non può più essere importato. Continuare?"
  ],
  [
    "A skill is defined by its SKILL.md file and managed in the library — it isn't edited here. Equip the skill onto an agent instead.",
    "技能由其 SKILL.md 文件定义并在库中管理 — 不能在此编辑。请将技能装备到代理上。",
    "스킬은 SKILL.md 파일에 의해 정의되며 라이브러리에서 관리됩니다 — 여기서 편집되지 않습니다. 대신 에이전트에 스킬을 장착하세요.",
    "スキルはSKILL.mdファイルによって定義され、ライブラリで管理されます — ここで編集することはできません。代わりに、スキルをエージェントに装備してください。",
    "يتم تعريف المهارة من خلال ملف SKILL.md الخاص بها وتُدار في المكتبة — لا يتم تعديلها هنا. بدلًا من ذلك، قم بتجهيز المهارة لوكيل.",
    "Una skill è definita dal suo file SKILL.md e gestita nella libreria — non viene modificata qui. Assegna invece la skill a un agente."
  ],
  [
    "A worker — takes a job from its boss and does it.",
    "一个工人 — 接受老板的工作并完成它。",
    "워커 — 상사로부터 일을 받아 수행합니다.",
    "ワーカー — 上司から仕事を受け取り、それを遂行します。",
    "عامل — يأخذ وظيفة من رئيسه وينفذها.",
    "Un lavoratore — prende un lavoro dal suo capo e lo esegue."
  ],
  [
    "Abliterate",
    "消除",
    "말소",
    "消去",
    "إبادة",
    "Ablattere"
  ],
  [
    "Abliterating…",
    "正在销毁…",
    "파괴 중…",
    "消去中…",
    "جارٍ الإبادة…",
    "Distruggendo…"
  ],
  [
    "Abliteration finds and deletes the single direction in the model's residual stream that's most responsible for refusal (\"Sorry, I can't help with that\") behaviour, without retraining.",
    "消除操作会在模型的残差流中找到并删除最可能导致拒绝（“抱歉，我无法帮忙”）行为的单一方向，无需重新训练。",
    "말소는 재학습 없이 모델의 잔여 스트림에서 거부(\"죄송합니다, 도와드릴 수 없습니다\") 행동에 가장 큰 영향을 미치는 단일 방향을 찾아 삭제합니다.",
    "消去は、モデルの残差ストリーム内で拒否（「申し訳ありませんが、それには対応できません」）行動の主な原因となる単一の方向を見つけて削除します。再訓練は行いません。",
    "الإبادة تجد وتحذف الاتجاه الواحد في تيار بقايا النموذج الذي يكون مسؤولاً أكثر عن سلوك الرفض (\"عذراً، لا أستطيع المساعدة في ذلك\")، دون إعادة تدريب.",
    "L'abliterazione trova ed elimina la singola direzione nel flusso residuo del modello più responsabile del comportamento di rifiuto (\"Spiacente, non posso aiutarti con questo\"), senza riaddestramento."
  ],
  [
    "About rules",
    "关于规则",
    "규칙에 관하여",
    "ルールについて",
    "حول القواعد",
    "Informazioni sulle regole"
  ],
  [
    "above — the key and the .cer are combined automatically.",
    "上方——密钥和 .cer 会自动合并。",
    "위 — 키와 .cer가 자동으로 결합됩니다.",
    "上 — キーと .cer は自動的に組み合わされます。",
    "أعلاه — يتم دمج المفتاح وملف .cer تلقائيًا.",
    "sopra — la chiave e il .cer sono combinati automaticamente."
  ],
  [
    "Absolute filesystem path for the output PNG.",
    "输出 PNG 的绝对文件系统路径。",
    "출력 PNG의 절대 파일 시스템 경로.",
    "出力PNGの絶対ファイルシステムパス。",
    "المسار الكامل للنظام لملف PNG الناتج.",
    "Percorso assoluto del filesystem per l'output PNG."
  ],
  [
    "Absolute or project-relative directory path.",
    "绝对路径或项目相对目录路径。",
    "절대 경로나 프로젝트 상대 디렉토리 경로.",
    "絶対パスまたはプロジェクト相対ディレクトリパス。",
    "مسار الدليل المطلق أو النسبي للمشروع.",
    "Percorso della directory assoluto o relativo al progetto."
  ],
  [
    "Absolute or project-relative file path.",
    "绝对或项目相关的文件路径。",
    "절대 경로나 프로젝트 상대 파일 경로.",
    "絶対パスまたはプロジェクト相対ファイルパス。",
    "مسار الملف المطلق أو النسبي للمشروع.",
    "Percorso del file assoluto o relativo al progetto."
  ],
  [
    "Absolute URL to fetch.",
    "要获取的绝对 URL。",
    "가져올 절대 URL.",
    "取得する絶対URL。",
    "رابط URL مطلق للتحميل.",
    "URL assoluto da recuperare."
  ],
  [
    "Absolute URL to screenshot.",
    "用于截图的绝对 URL。",
    "스크린샷을 찍을 절대 URL.",
    "スクリーンショットを撮る絶対URL。",
    "رابط URL مطلق لأخذ لقطة شاشة.",
    "URL assoluto da catturare."
  ],
  [
    "Accounts",
    "账户",
    "계정",
    "アカウント",
    "الحسابات",
    "Account"
  ],
  [
    "across",
    "跨越",
    "가로질러",
    "横断して",
    "عبر",
    "attraverso"
  ],
  [
    "Act directly — read, edit and run in the workspace",
    "直接操作——在工作区中读取、编辑和运行",
    "직접 실행 — 작업 공간에서 읽고, 수정하고, 실행하세요",
    "直接操作 — ワークスペースで読み、編集し、実行します",
    "تصرف مباشرة — اقرأ وحرر وشغّل في مساحة العمل",
    "Agisci direttamente — leggi, modifica ed esegui nello spazio di lavoro"
  ],
  [
    "action on this machine.",
    "在此机器上的操作。",
    "이 기계에서의 작업.",
    "このマシンでの操作。",
    "الإجراء على هذه الآلة.",
    "azione su questa macchina."
  ],
  [
    "Actions: 'screenshot' (capture the target's live video — returns an absolute saved PNG",
    "操作：'截图'（捕获目标的实时视频 — 返回已保存的 PNG 文件的绝对路径）",
    "동작: '스크린샷' (대상의 실시간 비디오를 캡처 — 절대 경로에 저장된 PNG 반환",
    "操作: 'スクリーンショット'（対象のライブビデオをキャプチャ — 絶対パスで保存されたPNGを返す）",
    "الإجراءات: 'لقطة شاشة' (التقاط فيديو مباشر للهدف — يُرجع ملف PNG محفوظ بشكل مطلق",
    "Azioni: 'screenshot' (cattura il video in diretta del bersaglio — restituisce un PNG salvato assoluto"
  ],
  [
    "Active inference servers",
    "活跃的推理服务器",
    "활성 추론 서버",
    "アクティブ推論サーバー",
    "خوادم الاستدلال النشطة",
    "Server di inferenza attivi"
  ],
  [
    "Acts as a normal team member",
    "作为普通团队成员行动",
    "일반 팀 멤버로 활동합니다",
    "通常のチームメンバーとして行動する",
    "يتصرف كعضو طبيعي في الفريق",
    "Agisce come un normale membro del team"
  ],
  [
    "Add",
    "添加",
    "추가",
    "追加",
    "إضافة",
    "Aggiungi"
  ],
  [
    "ADD A LOGIN",
    "添加登录",
    "로그인 추가",
    "ログインを追加",
    "إضافة تسجيل دخول",
    "AGGIUNGI UN LOGIN"
  ],
  [
    "Add a note for the team (a decision, a build command, where something lives…)",
    "为团队添加备注（一个决策、一个构建命令、某个东西的位置…）",
    "팀을 위한 메모 추가 (결정 사항, 빌드 명령, 위치 등…)",
    "チームへのメモを追加（決定事項、ビルドコマンド、何かがどこにあるか…）",
    "أضف ملاحظة للفريق (قرار، أمر بناء، مكان وجود شيء…)",
    "Aggiungi una nota per il team (una decisione, un comando di build, dove si trova qualcosa…)"
  ],
  [
    "Add agent from role",
    "从角色添加代理",
    "역할에서 에이전트 추가",
    "役割からエージェントを追加",
    "إضافة وكيل من الدور",
    "Aggiungi agente dal ruolo"
  ],
  [
    "Add all + clear notes",
    "添加所有 + 清除笔记",
    "모두 추가 + 메모 지우기",
    "すべて追加 + メモをクリア",
    "إضافة الجميع + مسح الملاحظات",
    "Aggiungi tutto + cancella note"
  ],
  [
    "Add at least one document or URL first.",
    "添加至少一个文档或网址。",
    "먼저 최소한 한 개의 문서나 URL 추가",
    "まず少なくとも1つのドキュメントまたはURLを追加",
    "أضف مستندًا أو رابطًا واحدًا على الأقل أولًا.",
    "Aggiungi almeno un documento o URL prima."
  ],
  [
    "Add context mention",
    "添加上下文提及",
    "컨텍스트 언급 추가",
    "コンテキストの言及を追加",
    "إضافة ذكر السياق",
    "Aggiungi menzione di contesto"
  ],
  [
    "Add documents",
    "添加文档",
    "문서 추가",
    "ドキュメントを追加",
    "إضافة مستندات",
    "Aggiungi documenti"
  ],
  [
    "Add MCP Server",
    "添加 MCP 服务器",
    "MCP 서버 추가",
    "MCPサーバーを追加",
    "إضافة خادم MCP",
    "Aggiungi server MCP"
  ],
  [
    "Add rule",
    "添加规则",
    "규칙 추가",
    "ルールを追加",
    "إضافة قاعدة",
    "Aggiungi regola"
  ],
  [
    "Add this step to the list",
    "将此步骤添加到列表中",
    "이 단계를 목록에 추가",
    "このステップをリストに追加",
    "إضافة هذه الخطوة إلى القائمة",
    "Aggiungi questo passo alla lista"
  ],
  [
    "Add Ubuntu — WSL is here, but only Docker's distro",
    "添加 Ubuntu — WSL 已到来，但仅限 Docker 的发行版",
    "Ubuntu 추가 — WSL이 있지만, Docker의 배포판만 가능합니다.",
    "Ubuntuを追加 — WSLは利用可能ですが、Dockerのディストリビューションのみです",
    "أضف أوبونتو — WSL موجود، ولكن توزيعة دوكر فقط",
    "Aggiungi Ubuntu — WSL è qui, ma solo la distro di Docker"
  ],
  [
    "Add your documents/URLs on the left, choose a model, and click",
    "在左侧添加你的文档/网址，选择一个模型，然后点击",
    "왼쪽에 문서/URL을 추가하고, 모델 선택 후 클릭",
    "左側にあなたのドキュメント/URLを追加し、モデルを選択してクリック",
    "أضف مستنداتك/روابطك على اليسار، اختر نموذجًا، ثم انقر",
    "Aggiungi i tuoi documenti/URL a sinistra, scegli un modello e clicca"
  ],
  [
    "Address: -",
    "地址：-",
    "주소: -",
    "住所: -",
    "العنوان: -",
    "Indirizzo: -"
  ],
  [
    "Admin / system",
    "管理员 / 系统",
    "관리자 / 시스템",
    "管理者 / システム",
    "الإدارة / النظام",
    "Amministratore / sistema"
  ],
  [
    "Advanced — team template & permissions",
    "高级 — 团队模板和权限",
    "고급 — 팀 템플릿 및 권한",
    "高度 — チームテンプレートと権限",
    "متقدم — قالب الفريق والأذونات",
    "Avanzato — modello del team e permessi"
  ],
  [
    "Advanced → CPU Configuration",
    "高级 → CPU 配置",
    "고급 → CPU 구성",
    "高度 → CPU構成",
    "متقدم → تكوين وحدة المعالجة المركزية",
    "Avanzato → Configurazione CPU"
  ],
  [
    "Advanced ⚙",
    "高级 ⚙",
    "고급 ⚙",
    "高度 ⚙",
    "متقدم ⚙",
    "Avanzato ⚙"
  ],
  [
    "agent",
    "代理",
    "에이전트",
    "エージェント",
    "وكيل",
    "Agente"
  ],
  [
    "Agent",
    "代理",
    "대리인",
    "代理人",
    "وكيل",
    "Agente"
  ],
  [
    "Agent Browser — view and drive the shared web browser your agents control with the browser_* tools (live page view, open URLs, persistent logins).",
    "代理浏览器 — 使用 browser_* 工具查看并操作您的代理控制的共享网页浏览器（实时页面查看、打开 URL、持久登录）。",
    "에이전트 브라우저 — browser_* 도구(실시간 페이지 보기, URL 열기, 지속 로그인)를 사용하여 에이전트가 제어하는 공유 웹 브라우저를 보고 조작할 수 있습니다.",
    "エージェントブラウザ — エージェントがbrowser_*ツールで制御する共有ウェブブラウザを表示および操作します（ライブページ表示、URLを開く、永続的ログイン）。",
    "متصفح الوكيل — عرض والتحكم في المتصفح المشترك الذي يتحكم فيه وكلاؤك باستخدام أدوات browser_* (عرض الصفحة مباشرة، فتح عناوين URL، تسجيلات دخول مستمرة).",
    "Browser Agente — visualizza e controlla il browser web condiviso che i tuoi agenti gestiscono con gli strumenti browser_* (visualizzazione live della pagina, apri URL, accessi persistenti)."
  ],
  [
    "Agent can use tools",
    "代理可以使用工具",
    "에이전트가 도구를 사용할 수 있음",
    "エージェントはツールを使用できます",
    "يمكن للوكيل استخدام الأدوات",
    "L'agente può usare gli strumenti"
  ],
  [
    "Agent settings ·",
    "代理设置 ·",
    "에이전트 설정 ·",
    "エージェント設定 ·",
    "إعدادات الوكيل ·",
    "Impostazioni agente ·"
  ],
  [
    "Agent tools installed in {0}.",
    "已在 {0} 安装代理工具。",
    "{0}에 설치된 에이전트 도구.",
    "{0} にエージェントツールがインストールされています。",
    "الأدوات المثبتة للوكيل في {0}.",
    "Strumenti dell'agente installati in {0}."
  ],
  [
    "Agent tools installed; synced logins: {0}.",
    "已安装代理工具；已同步登录信息：{0}。",
    "설치된 에이전트 도구; 동기화된 로그인: {0}.",
    "エージェントツールがインストールされました; 同期されたログイン: {0}。",
    "الأدوات المثبتة للوكيل؛ تسجيلات الدخول المتزامنة: {0}.",
    "Strumenti dell'agente installati; accessi sincronizzati: {0}."
  ],
  [
    "Agent tools installed. Found {0} on Windows but couldn't copy into the sandbox — click 'Sync logins' to retry.",
    "代理工具已安装。在 Windows 上找到 {0}，但无法复制到沙箱中 — 点击“同步登录”重试。",
    "에이전트 도구가 설치되었습니다. Windows에서 {0}를 찾았지만 샌드박스로 복사할 수 없습니다 — 재시도하려면 '로그인 동기화'를 클릭하세요.",
    "エージェントツールがインストールされました。Windowsで{0}が見つかりましたが、サンドボックスにコピーできませんでした — 再試行するには「ログインを同期」をクリックしてください。  ",
    "تم تثبيت أدوات الوكيل. تم العثور على {0} على Windows لكن لم يتمكن من النسخ إلى الحماية الرملية — اضغط 'مزامنة تسجيلات الدخول' لإعادة المحاولة.",
    "Strumenti dell'agente installati. Trovato {0} su Windows ma non è stato possibile copiarlo nella sandbox — clicca 'Sincronizza accessi' per riprovare."
  ],
  [
    "Agent tools installed. Log in via Accounts, then click 'Sync logins'.",
    "已安装代理工具。通过账户登录，然后点击“同步登录”。",
    "에이전트 도구가 설치되었습니다. 계정을 통해 로그인한 후 '로그인 동기화'를 클릭하세요.",
    "エージェントツールがインストールされました。アカウントでログインしてから、「ログインを同期」をクリックしてください。",
    "تم تثبيت أدوات الوكيل. سجّل الدخول عبر الحسابات، ثم انقر على 'مزامنة تسجيلات الدخول'.",
    "Strumenti dell'agente installati. Accedi tramite Account, poi clicca 'Sincronizza accessi'."
  ],
  [
    "agent↔agent conversation — pauses after",
    "代理↔代理对话 — 之后暂停",
    "에이전트↔에이전트 대화 — 일시 정지 후",
    "エージェント↔エージェントの会話 — 後で一時停止します  ",
    "محادثة وكيل↔وكيل — توقفات بعد",
    "conversazione agente↔agente — pause dopo"
  ],
  [
    "Agentic Team",
    "代理团队",
    "에이전트 팀",
    "エージェンティックチーム",
    "الفريق الوكلي",
    "Team Agentico"
  ],
  [
    "agents",
    "代理们",
    "에이전트들",
    "エージェント",
    "الوكلاء",
    "AGENTI"
  ],
  [
    "Agents",
    "代理人",
    "대리인",
    "代理人",
    "وكلاء",
    "Agenti"
  ],
  [
    "AGENTS",
    "代理人",
    "에이전트",
    "エージェント",
    "وكلاء",
    "AGENTI"
  ],
  [
    "Agents → pick an agent → 📚 Skills",
    "代理 → 选择一个代理 → 📚 技能",
    "에이전트 → 에이전트 선택 → 📚 스킬",
    "エージェント → エージェントを選択 → 📚 スキル  ",
    "الوكلاء → اختر وكيلاً → 📚 المهارات",
    "Agenti → scegli un agente → 📚 Competenze"
  ],
  [
    "agents on team",
    "团队中的代理",
    "팀의 에이전트들",
    "チーム内のエージェント",
    "الوكلاء في الفريق",
    "agenti nel team"
  ],
  [
    "Agents run OUTSIDE the sandbox — full access to your PC. Click to turn back off.",
    "代理在沙箱外运行 — 完全访问你的电脑。点击以关闭。",
    "에이전트는 샌드박스 외부에서 실행됨 — PC에 대한 전체 접근. 다시 끄려면 클릭하세요.",
    "エージェントはサンドボックスの外で実行されます — PCへの完全アクセスがあります。オフに戻すにはクリックしてください。",
    "الوكلاء يعملون خارج الحماية الرملية — وصول كامل إلى جهاز الكمبيوتر الخاص بك. اضغط لإيقاف التشغيل مرة أخرى.",
    "Gli agenti vengono eseguiti FUORI dalla sandbox — accesso completo al tuo PC. Clicca per disattivare."
  ],
  [
    "Agents run sandboxed by default — security, folder and team can all be changed later in ⚙ Project settings.",
    "代理默认在沙箱中运行——安全性、文件夹和团队都可以在⚙ 项目设置中稍后更改。",
    "에이전트는 기본적으로 샌드박스 환경에서 실행됩니다 — 보안, 폴더 및 팀은 나중에 ⚙ 프로젝트 설정에서 모두 변경할 수 있습니다.",
    "エージェントはデフォルトでサンドボックス内で実行されます — セキュリティ、フォルダ、チームはすべてあとで⚙ プロジェクト設定で変更できます。",
    "العملاء يعملون في بيئة معزولة افتراضيًا — يمكن تغيير الأمان والمجلد والفريق لاحقًا في ⚙ إعدادات المشروع.",
    "Gli agenti vengono eseguiti in modalità sandbox per impostazione predefinita: sicurezza, cartella e team possono tutti essere modificati successivamente in ⚙ Impostazioni progetto."
  ],
  [
    "Agents send inference to a llama-server on another host (e.g. your Windows GPU box). Run agents here, model there.",
    "代理将推理发送到另一台主机上的 llama 服务器（例如，你的 Windows GPU 设备）。在这里运行代理，模型在那边运行。",
    "에이전트는 다른 호스트(예: Windows GPU 박스)에 있는 라마 서버로 추론을 보냅니다. 여기서 에이전트를 운영하고, 모델은 저기서 실행합니다.",
    "エージェントは、別のホスト上のラマサーバーに推論を送信します（例：あなたのWindows GPUマシン）。ここでエージェントを実行し、モデルはそこで動かします。",
    "يقوم الوكلاء بإرسال الاستنتاج إلى خادم لاما على جهاز آخر (مثل جهاز GPU الخاص بك على ويندوز). شغّل الوكلاء هنا، والنموذج هناك.",
    "Gli agenti inviano inferenze a un server llama su un altro host (ad esempio il tuo PC Windows con GPU). Esegui gli agenti qui, il modello lì."
  ],
  [
    "Agents use this PC's managed llama-server (default).",
    "代理使用这台电脑的托管 llama 服务器（默认）。",
    "에이전트는 이 PC에서 관리되는 라마 서버를 사용합니다(기본값).",
    "エージェントはこのPCの管理されたラマサーバーを使用します（デフォルト）。",
    "يستخدم الوكلاء خادم لاما المدار على هذا الكمبيوتر (افتراضي).",
    "Gli agenti usano il server llama gestito di questo PC (predefinito)."
  ],
  [
    "agents, wired and ready",
    "代理，已连接并准备好",
    "에이전트 준비 완료, 연결됨",
    "エージェント、接続済みで準備完了",
    "الوكلاء، جاهزون ومتصلة",
    "agenti, collegati e pronti"
  ],
  [
    "agents)",
    "代理)",
    "에이전트)",
    "エージェント)",
    "الوكلاء)",
    "agenti)"
  ],
  [
    "AI-assisted",
    "AI 辅助",
    "AI 지원",
    "AIサポート付き",
    "مدعوم بالذكاء الاصطناعي",
    "Assistito dall'IA"
  ],
  [
    "all",
    "全部",
    "모두",
    "すべて",
    "الكل",
    "tutti"
  ],
  [
    "all builtins",
    "所有内置功能",
    "모든 내장 기능",
    "すべての組み込み機能",
    "جميع الوظائف المدمجة",
    "tutti i built-in"
  ],
  [
    "All campaigns",
    "所有活动",
    "모든 캠페인",
    "すべてのキャンペーン",
    "جميع الحملات",
    "Tutte le campagne"
  ],
  [
    "All platforms",
    "所有平台",
    "모든 플랫폼",
    "すべてのプラットフォーム",
    "جميع المنصات",
    "Tutte le piattaforme"
  ],
  [
    "All steps done — reopen one from Completed below, or add a new step above.",
    "所有步骤完成——从下方已完成中重新打开一个，或在上方添加一个新步骤。",
    "모든 단계가 완료되었습니다 — 아래 완료된 항목에서 하나를 다시 열거나 위에 새 단계를 추가하세요.",
    "すべてのステップが完了しました — 下の「完了済み」から1つを再開するか、上に新しいステップを追加してください。",
    "تمت جميع الخطوات — أعد فتح واحدة من المكتملة أدناه، أو أضف خطوة جديدة أعلاه.",
    "Tutti i passaggi completati — riapri uno da Completati qui sotto, oppure aggiungi un nuovo passaggio sopra."
  ],
  [
    "all templates",
    "所有模板",
    "모든 템플릿",
    "すべてのテンプレート",
    "جميع القوالب",
    "tutti i modelli"
  ],
  [
    "Allow all MCP tools (no restriction)",
    "允许所有 MCP 工具（无限制）",
    "모든 MCP 도구 허용(제한 없음)",
    "すべてのMCPツールを許可（制限なし）",
    "السماح بجميع أدوات MCP (بدون قيود)",
    "Consenti tutti gli strumenti MCP (nessuna restrizione)"
  ],
  [
    "Almost there — install Python in Ubuntu",
    "快完成了——在 Ubuntu 中安装 Python",
    "거의 다 왔습니다 — Ubuntu에 Python 설치",
    "もう少しで完了 — Ubuntu に Python をインストールする  ",
    "يكاد ينتهي — قم بتثبيت بايثون على أوبونتو",
    "Quasi pronto — installa Python su Ubuntu"
  ],
  [
    "alongside it — the Virtual Machine Platform is already on, so",
    "同时安装——虚拟机平台已经启动，所以",
    "그 옆에 — 가상 머신 플랫폼은 이미 켜져 있습니다, 그래서",
    "それと一緒に — 仮想マシンプラットフォームはすでにオンになっているので  ",
    "إلى جانبه — منصة الآلة الافتراضية مفعلة بالفعل، لذا",
    "insieme a esso — la Piattaforma Macchina Virtuale è già attiva, quindi"
  ],
  [
    "Also show the auto-captured worklog transcript (unconnected recent-activity rows)",
    "还显示自动捕获的工作日志记录（未连接的最近活动行）",
    "자동 캡처된 작업 로그 전사본도 표시 (연결되지 않은 최근 활동 행)",
    "自動的にキャプチャされた作業ログの記録も表示します（未接続の最近のアクティビティ行）",
    "أيضًا عرض سجل عمل التلقائي الملتقط (صفوف النشاط الأخيرة غير المتصلة)",
    "Mostra anche la trascrizione del registro di lavoro catturata automaticamente (righe di attività recenti non connesse)"
  ],
  [
    "always-present advisor",
    "常驻顾问",
    "항상 존재하는 조언자",
    "常駐アドバイザー",
    "المستشار الدائم الحضور",
    "consulente sempre presente"
  ],
  [
    "Amber",
    "Amber",
    "앰버",
    "アンバー",
    "أمبر",
    "Amber"
  ],
  [
    "An install is running — it keeps going even if you leave this page.",
    "正在运行安装——即使你离开此页面，它也会继续进行。",
    "설치가 진행 중입니다 — 이 페이지를 떠나도 계속 진행됩니다.",
    "インストールが実行中 — このページを離れても進行し続ける。",
    "يتم تشغيل التثبيت — يستمر حتى لو غادرت هذه الصفحة.",
    "Un'installazione è in corso — continua anche se lasci questa pagina."
  ],
  [
    "and can't reach your",
    "并且无法访问你的",
    "그리고 도달할 수 없습니다",
    "そしてあなたに届かない",
    "ولا يمكن الوصول إلى",
    "e non riesce a raggiungere il tuo"
  ],
  [
    "and committed with the repo, so every machine and teammate uses the same rules. Leave verify blank to auto-detect from the project.",
    "并提交到仓库中，这样每台机器和每个团队成员都使用相同的规则。将 verify 留空以从项目中自动检测。",
    "레포와 함께 커밋되었기 때문에 모든 머신과 팀원이 동일한 규칙을 사용합니다. 프로젝트에서 자동 감지를 위해 확인란을 비워 두세요.",
    "そしてリポジトリにコミットされたので、すべてのマシンとチームメイトが同じルールを使用します。プロジェクトから自動検出するには検証を空白のままにしてください。",
    "وتم الالتزام به مع المستودع، لذلك كل جهاز وزميل في الفريق يستخدم نفس القواعد. اترك التحقق فارغًا للكشف التلقائي من المشروع.",
    "e committato con il repo, quindi ogni macchina e ogni compagno di squadra usa le stesse regole. Lascia vuoto verifica per rilevare automaticamente dal progetto."
  ],
  [
    "and paste it on the Home page.)",
    "并将其粘贴到主页上。",
    "그리고 홈 페이지에 붙여넣습니다.)",
    "そしてホームページに貼り付けます。)",
    "ولصقه على الصفحة الرئيسية.)",
    "e incollalo sulla pagina Home."
  ],
  [
    "and paste them into the repo's Settings → Secrets.",
    "并将它们粘贴到仓库的设置 → 密钥中。",
    "그리고 그것들을 저장소의 설정 → 시크릿에 붙여넣으세요.",
    "それらをリポジトリの設定 → シークレットに貼り付けます。",
    "ولا تُلصقها في إعدادات المستودع → الأسرار.",
    "e incollali nelle Impostazioni → Segreti del repository. "
  ],
  [
    "and returns every file whose name matches `pattern`. Supports",
    "并返回每个名称匹配 `pattern` 的文件。支持",
    "그리고 이름이 `pattern`과 일치하는 모든 파일을 반환합니다. 지원",
    "そして `pattern` に一致する名前のすべてのファイルを返します。サポートされています",
    "ويعيد كل ملف اسمه يطابق `pattern`. يدعم",
    "e restituisce ogni file il cui nome corrisponde a `pattern`. Supporta"
  ],
  [
    "AND send a mobile user-agent, so responsive layouts and UA-sniffing sites",
    "并发送移动用户代理，因此响应式布局和用户代理嗅探的网站",
    "모바일 사용자 에이전트를 보내도록, 그래서 반응형 레이아웃과 UA 스니핑 사이트에서",
    "そしてモバイルユーザーエージェントを送信し、レスポンシブレイアウトとユーザーエージェントを判別するサイトに対応し、",
    "وأرسل وكيل مستخدم للهاتف المحمول، حتى تخطيطات الاستجابة والمواقع التي تتحسس وكيل المستخدم",
    "E invia un user-agent mobile, così i layout responsivi e i siti che rilevano l'UA"
  ],
  [
    "and works across networks (same LAN, a Tailscale/VPN overlay, or a relay) over the",
    "并可跨网络工作（同一局域网、Tailscale/VPN 覆盖网络或中继）",
    "그리고 네트워크를 통해 작동 (같은 LAN, Tailscale/VPN 오버레이, 또는 릴레이) 상에서",
    "ネットワークを越えて（同じLAN、Tailscale/VPNオーバーレイ、またはリレーを通じて）動作する",
    "وتعمل عبر الشبكات (نفس الشبكة المحلية، طبقة Tailscale/VPN، أو تتابع) عبر ال",
    "funzionano su tutte le reti (stessa LAN, un overlay Tailscale/VPN o un relay) su"
  ],
  [
    "Answer, push back, or say ‘go’ to research + write the brief…",
    "回答、拒绝或说“开始”来进行研究并撰写简报…",
    "답변하거나, 되돌리거나, 또는 ‘go’라고 말하여 조사하고 간단히 작성하세요…",
    "回答する、差し戻す、または『進め』と言って調査して簡単な文書を書く…",
    "أجب، أو ادفع الرد، أو قل 'انطلق' للبحث وكتابة الملخص...",
    "Rispondi, ritorna indietro, o dì ‘vai’ per ricercare e scrivere il breve…"
  ],
  [
    "answers my decisions + approves/rejects the plan + answer",
    "回答我的决策 + 批准/拒绝计划 + 回答",
    "내 결정에 답변 + 계획 승인/거부 + 답변",
    "私の決定に答え、計画を承認/拒否し、答える",
    "يجيب على قراراتي + يوافق/يرفض الخطة + الإجابة",
    "risponde alle mie decisioni + approva/rifiuta il piano + risponde"
  ],
  [
    "ANTHROPIC",
    "ANTHROPIC",
    "앤트로픽",
    "ANTHROPIC",
    "أنثروبيك",
    "ANTHROPIC"
  ],
  [
    "any network the two machines can route to each other on",
    "两台机器可以互相路由的任何网络",
    "두 기계가 서로 라우팅할 수 있는 모든 네트워크",
    "二台のマシンが互いにルーティングできる任意のネットワーク",
    "أي شبكة يمكن للجهازين التوجيه إليها بين بعضهما البعض",
    "qualsiasi rete su cui le due macchine possono instradarsi tra loro"
  ],
  [
    "api",
    "API",
    "API",
    "API",
    "واجهة برمجة التطبيقات",
    "API"
  ],
  [
    "API",
    "应用程序接口",
    "API",
    "API",
    "واجهة برمجة التطبيقات",
    "API"
  ],
  [
    "API key (the remote server's --api-key, optional)",
    "API密钥（远程服务器的 --api-key，可选）",
    "API 키 (원격 서버의 --api-key, 선택 사항)",
    "APIキー（リモートサーバーの --api-key、オプション）",
    "مفتاح API (خادم بعيد --api-key، اختياري)",
    "Chiave API (del server remoto --api-key, opzionale)"
  ],
  [
    "API key saved",
    "API 密钥已保存",
    "API 키가 저장됨",
    "APIキーが保存されました",
    "تم حفظ مفتاح واجهة برمجة التطبيقات",
    "Chiave API salvata"
  ],
  [
    "API key: owllm-local",
    "API密钥：owllm-local",
    "API 키: owllm-local",
    "APIキー：owllm-local",
    "مفتاح API: owllm-local",
    "Chiave API: owllm-local"
  ],
  [
    "app capture preview",
    "应用捕获预览",
    "앱 캡처 미리보기",
    "アプリキャプチャプレビュー",
    "معاينة التقاط التطبيق",
    "anteprima cattura app"
  ],
  [
    "app password",
    "应用密码",
    "앱 비밀번호",
    "アプリパスワード",
    "كلمة مرور التطبيق",
    "password app"
  ],
  [
    "app's end-to-end-encrypted device channel. Use for tech support, installing software,",
    "应用的端到端加密设备通道。用于技术支持、安装软件，",
    "앱의 종단 간 암호화된 장치 채널. 기술 지원, 소프트웨어 설치에 사용",
    "アプリのエンドツーエンド暗号化デバイスチャネル。テクニカルサポートやソフトウェアのインストールに使用します。",
    "قناة الجهاز المشفرة من النهاية إلى النهاية للتطبيق. استخدمها للدعم التقني، وتثبيت البرامج,",
    "canale del dispositivo crittografato end-to-end dell'app. Usare per supporto tecnico, installazione software,"
  ],
  [
    "Appearance and language settings",
    "外观和语言设置",
    "외관 및 언어 설정",
    "外観と言語設定",
    "إعدادات المظهر واللغة",
    "Aspetto e impostazioni della lingua"
  ],
  [
    "Apple — Developer ID (macOS)",
    "Apple — 开发者 ID（macOS）",
    "Apple — 개발자 ID (macOS)",
    "Apple — デベロッパーID（macOS）",
    "أبل — معرف المطور (macOS)",
    "Apple — ID sviluppatore (macOS)"
  ],
  [
    "Apple incomplete",
    "Apple 不完整",
    "Apple 미완료",
    "Apple 未完了",
    "Apple غير مكتمل",
    "Apple incompleto"
  ],
  [
    "Apple ready",
    "Apple 准备就绪",
    "Apple 준비 완료",
    "Apple 準備完了",
    "Apple جاهز",
    "Apple pronto"
  ],
  [
    "APPLE_*",
    "APPLE_*",
    "APPLE_*",
    "APPLE_*",
    "APPLE_*",
    "APPLE_*"
  ],
  [
    "APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID — e.g. to set them as GitHub Actions secrets. Handle secret",
    "APPLE_ID、APPLE_PASSWORD、APPLE_TEAM_ID — 例如将它们设置为 GitHub Actions 秘密。处理秘密",
    "APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID — 예: GitHub Actions 비밀로 설정하기 위해. 비밀 취급",
    "APPLE_ID、APPLE_PASSWORD、APPLE_TEAM_ID — 例：GitHub Actionsのシークレットとして設定する場合。シークレットを取り扱う",
    "APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID — على سبيل المثال لتعيينها كأسرار في GitHub Actions. التعامل مع السر",
    "APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID — ad esempio per impostarli come secret in GitHub Actions. Gestire segreto"
  ],
  [
    "Applied to every agent's system prompt + the critic when director mode is on.",
    "应用到每个代理的系统提示 + 当导演模式开启时应用于评论者。",
    "모든 에이전트의 시스템 프롬프트 + 감독 모드가 켜진 경우 크리틱에 적용됨.",
    "ディレクターモードがオンのとき、すべてのエージェントのシステムプロンプトとクリティックに適用されます。",
    "تطبيق على كل مطالبة نظام الوكيل + الناقد عندما يكون وضع المدير مفعلًا.",
    "Applicato al prompt di sistema di ogni agente + al critico quando la modalità direttore è attiva."
  ],
  [
    "Apply auto-fixes now",
    "现在应用自动修复",
    "지금 자동 수정을 적용",
    "今すぐ自動修正を適用",
    "تطبيق الإصلاحات التلقائية الآن",
    "Applica correzioni automatiche ora"
  ],
  [
    "Apply failed:",
    "应用失败：",
    "적용 실패:",
    "適用に失敗しました：",
    "فشل التطبيق:",
    "Applicazione fallita:"
  ],
  [
    "Applying…",
    "应用中…",
    "적용 중…",
    "適用中…",
    "التطبيق جاري...",
    "Applicazione…"
  ],
  [
    "Approval gated:",
    "审批受限：",
    "승인 필요:",
    "承認制限：",
    "الموافقة محجوزة:",
    "Approvazione vincolata:"
  ],
  [
    "Approve once",
    "批准一次",
    "한 번 승인",
    "一度承認",
    "الموافقة مرة واحدة",
    "Approva una volta"
  ],
  [
    "Approved",
    "已批准",
    "승인됨",
    "承認済み",
    "تمت الموافقة",
    "Approvato"
  ],
  [
    "Approving grants",
    "批准授予",
    "보조금 승인",
    "助成金の承認",
    "الموافقة على المنح",
    "Approvare sovvenzioni"
  ],
  [
    "apt",
    "apt",
    "적합한",
    "適切",
    "ملائم",
    "adatto"
  ],
  [
    "Archive",
    "存档",
    "보관",
    "アーカイブ",
    "أرشيف",
    "Archivio"
  ],
  [
    "Arena",
    "竞技场",
    "경기장",
    "アリーナ",
    "ساحة",
    "Arena"
  ],
  [
    "Args (space-separated):",
    "参数（以空格分隔）:",
    "공백으로 구분된 인수:",
    "引数（スペースで区切る）：",
    "المعامل (مفصولة بمسافة):",
    "Argomenti (separati da spazi):"
  ],
  [
    "Ask anything — no project, no setup. Uses the model picked above (local or cloud). To have the model work inside a folder, go back and pick “New project” or “Open a project folder”.",
    "随便问 — 无需项目，无需设置。使用上面选择的模型（本地或云端）。若要让模型在一个文件夹内工作，请返回并选择“新建项目”或“打开项目文件夹”。",
    "무엇이든 물어보세요 — 프로젝트도, 설정도 필요 없습니다. 위에서 선택한 모델(로컬 또는 클라우드)을 사용합니다. 모델을 폴더 내에서 사용하려면 돌아가서 “새 프로젝트” 또는 “프로젝트 폴더 열기”를 선택하세요.",
    "何でも質問してください — プロジェクトも設定も不要です。上で選択したモデル（ローカルまたはクラウド）を使用します。モデルをフォルダ内で動作させたい場合は、「新しいプロジェクト」または「プロジェクトフォルダを開く」を選んでください。",
    "اسأل أي شيء — لا مشروع، لا إعداد. يستخدم النموذج المختار أعلاه (محلي أو سحابي). لجعل النموذج يعمل داخل مجلد، ارجع واختر \"مشروع جديد\" أو \"فتح مجلد مشروع\".",
    "Chiedi qualsiasi cosa — nessun progetto, nessuna configurazione. Usa il modello scelto sopra (locale o cloud). Per far funzionare il modello all'interno di una cartella, torna indietro e scegli “Nuovo progetto” o “Apri una cartella di progetto”."
  ],
  [
    "Ask me anything about the app — what broke, what a page does, what to try…",
    "随便问我有关应用的任何问题 — 什么坏了，某个页面是做什么的，应该尝试什么…",
    "앱에 대해 무엇이든 물어보세요 — 무엇이 고장 났는지, 페이지가 무엇을 하는지, 무엇을 시도할지…",
    "アプリについて何でも聞いてください — 何が壊れたか、ページが何をするか、何を試すべきか…",
    "اسألني أي شيء عن التطبيق — ما الذي تعطل، ماذا تفعل الصفحة، ما الذي يجب تجربته...",
    "Chiedimi qualsiasi cosa sull'app — cosa si è rotto, cosa fa una pagina, cosa provare…"
  ],
  [
    "Ask-only prompt",
    "仅提问提示",
    "묻기 전용 프롬프트",
    "質問専用プロンプト",
    "مطالبة للطرح فقط",
    "Prompt solo per chiedere"
  ],
  [
    "Ask, discuss, review — nothing is modified in chat mode…",
    "提问、讨论、复习——在聊天模式中没有任何修改…",
    "물어보고, 토론하고, 검토하세요 — 채팅 모드에서는 아무것도 수정되지 않습니다…",
    "尋ねる、議論する、レビューする — チャットモードでは何も変更されません…",
    "اسأل، ناقش، راجع — لا شيء يتغير في وضع الدردشة…",
    "Chiedi, discuti, rivedi — nulla viene modificato in modalità chat…"
  ],
  [
    "Ask, edit, or run an agent task. Type / for commands, # for context.",
    "提问、编辑或运行代理任务。输入 / 获取命令，输入 # 获取上下文。",
    "묻고, 편집하거나, 에이전트 작업을 실행하세요. 명령어는 /, 컨텍스트는 #를 입력하세요.",
    "質問、編集、またはエージェントタスクを実行。コマンドは /、コンテキストは # を入力してください。",
    "اسأل، حرر، أو نفذ مهمة وكيل. اكتب / للأوامر، # للسياق.",
    "Chiedi, modifica o esegui un'attività dell'agente. Digita / per i comandi, # per il contesto."
  ],
  [
    "Asset Preview",
    "资产预览",
    "자산 미리보기",
    "アセットプレビュー",
    "معاينة الأصول",
    "Anteprima risorsa"
  ],
  [
    "at",
    "在",
    "에서",
    "で",
    "على",
    "a"
  ],
  [
    "at ~/owllm/",
    "在 ~/owllm/",
    "~/owllm/에서",
    "で ~/owllm/",
    "في ~/owllm/",
    "a ~/owllm/"
  ],
  [
    "at boot to enter the BIOS/UEFI.",
    "启动时进入 BIOS/UEFI。",
    "부팅 시 BIOS/UEFI에 들어가려면.",
    "起動時にBIOS/UEFIに入る。",
    "أثناء الإقلاع للدخول إلى BIOS/UEFI.",
    "al momento dell'avvio per entrare nel BIOS/UEFI."
  ],
  [
    "at the top) to pick a team template, or start a fresh one with",
    "在顶部）选择团队模板，或从头开始新建一个",
    "상단에서) 팀 템플릿을 선택하거나, 새로 시작하려면",
    "上部で）チームテンプレートを選ぶか、新しいものを始める",
    "في الأعلى) لاختيار قالب فريق، أو بدء قالب جديد",
    "in alto) per scegliere un modello di team, o iniziare uno nuovo con"
  ],
  [
    "Attach a file",
    "附加文件",
    "파일 첨부",
    "ファイルを添付",
    "إرفاق ملف",
    "Allega un file"
  ],
  [
    "Attach image (or just paste one)",
    "附加图片（或直接粘贴一张）",
    "이미지 첨부 (또는 그냥 붙여넣기)",
    "画像を添付（またはコピー＆ペースト）",
    "إرفاق صورة (أو فقط لصق واحدة)",
    "Allega immagine (o semplicemente incollane una)"
  ],
  [
    "Attach image(s)",
    "附加图片",
    "이미지 첨부(들)",
    "画像を添付",
    "إرفاق صورة/صور",
    "Allega immagine/i"
  ],
  [
    "Audio",
    "音频",
    "오디오",
    "オーディオ",
    "صوت",
    "Audio"
  ],
  [
    "Audit log",
    "审计日志",
    "감사 로그",
    "監査ログ",
    "سجل التدقيق",
    "Registro di controllo"
  ],
  [
    "Auth token",
    "身份验证令牌",
    "인증 토큰",
    "認証トークン",
    "رمز المصادقة",
    "Token di autenticazione"
  ],
  [
    "Authorize",
    "授权",
    "승인",
    "承認",
    "تفويض",
    "Autorizza"
  ],
  [
    "auto",
    "自动",
    "자동",
    "自動",
    "تلقائي",
    "Auto"
  ],
  [
    "Auto",
    "自动",
    "자동",
    "オート",
    "تلقائي",
    "Auto"
  ],
  [
    "Auto (per-task selection)",
    "自动（每任务选择）",
    "자동 (작업별 선택)",
    "自動（タスクごとの選択）",
    "تلقائي (اختيار لكل مهمة)",
    "Auto (selezione per attività)"
  ],
  [
    "Auto (running local first)",
    "自动（优先本地运行）",
    "자동 (로컬에서 먼저 실행)",
    "自動（まずローカルで実行）",
    "التشغيل التلقائي (تشغيل محلي أولاً)",
    "Auto (in esecuzione locale prima)"
  ],
  [
    "Auto mode",
    "自动模式",
    "자동 모드",
    "自動モード",
    "الوضع التلقائي",
    "Modalità Auto"
  ],
  [
    "Auto mode is OFF — agents wait for approval",
    "自动模式已关闭 — 客服等待批准",
    "자동 모드가 꺼져 있음 — 상담원이 승인을 기다림",
    "自動モードはオフ — エージェントは承認を待ちます",
    "وضع التلقائي متوقف — الوكلاء ينتظرون الموافقة",
    "La modalità automatica è SPENTA — gli agenti aspettano l'approvazione"
  ],
  [
    "Auto mode is ON — agents auto-accept tool calls",
    "自动模式已开启 — 客服自动接受工具调用",
    "자동 모드가 켜져 있음 — 상담원이 도구 호출을 자동으로 수락함",
    "自動モードはオン — エージェントはツール呼び出しを自動承認します",
    "وضع التلقائي مفعل — الوكلاء يقبلون مكالمات الأدوات تلقائيًا",
    "La modalità automatica è ACCESA — gli agenti accettano automaticamente le chiamate dello strumento"
  ],
  [
    "Auto voice",
    "自动语音",
    "자동 음성",
    "自動音声",
    "الصوت التلقائي",
    "Voce automatica"
  ],
  [
    "Auto-approve every tool call",
    "自动批准每个工具调用",
    "모든 도구 호출 자동 승인",
    "すべてのツール呼び出しを自動承認",
    "الموافقة التلقائية على كل استدعاء أداة",
    "Approvare automaticamente ogni chiamata allo strumento"
  ],
  [
    "Auto-approve every tool call (only for personal bots)",
    "自动批准每个工具调用（仅适用于个人机器人）",
    "모든 도구 호출 자동 승인 (개인 봇만 해당)",
    "すべてのツール呼び出しを自動承認（個人ボットのみ）",
    "الموافقة التلقائية على كل استدعاء أداة (للبوتات الشخصية فقط)",
    "Approvare automaticamente ogni chiamata allo strumento (solo per bot personali)"
  ],
  [
    "auto-approve tool requests",
    "自动批准工具请求",
    "도구 요청 자동 승인",
    "ツールリクエストを自動承認",
    "الموافقة التلقائية على طلبات الأدوات",
    "approvare automaticamente le richieste dello strumento"
  ],
  [
    "Auto-captured record of recent agent work — local to this PC, capped",
    "自动记录的最近客服工作 — 存储在本地电脑，有限制",
    "최근 상담원 작업의 자동 기록 — 이 PC에 로컬 저장, 용량 제한",
    "最近のエージェント作業の自動記録 — このPCにローカルで保存、上限あり",
    "سجل ملتقط تلقائيًا لعمل الوكيل الأخير — محلي على هذا الكمبيوتر، محدود",
    "Registro automaticamente acquisito del lavoro recente degli agenti — locale su questo PC, limitato"
  ],
  [
    "auto-detected — e.g. npm run build · cargo check · pytest -q",
    "自动检测 — 例如 npm run build · cargo check · pytest -q",
    "자동 감지 — 예: npm run build · cargo check · pytest -q",
    "自動検出 — 例: npm run build · cargo check · pytest -q",
    "تم الاكتشاف تلقائيًا — على سبيل المثال npm run build · cargo check · pytest -q",
    "rilevato automaticamente — ad es. npm run build · cargo check · pytest -q"
  ],
  [
    "auto-doc after merge",
    "合并后自动生成文档",
    "병합 후 자동 문서화",
    "マージ後自動ドキュメント作成",
    "توثيق تلقائي بعد الدمج",
    "documentazione automatica dopo il merge"
  ],
  [
    "Auto-feed (another page drives)",
    "自动喂养（由另一页面驱动）",
    "자동 피드 (다른 페이지 기반)",
    "自動フィード（別のページから情報取得）",
    "التغذية التلقائية (صفحة أخرى تقوم بالقيادة)",
    "Alimentazione automatica (guida un'altra pagina)"
  ],
  [
    "Auto-feed is driven by another page on this project. Uncheck to stop it everywhere; check again afterwards to drive it from this page.",
    "自动喂养由该项目的另一页面驱动。取消勾选可在所有地方停止；之后重新勾选可从此页面驱动。",
    "자동 피드는 이 프로젝트의 다른 페이지에서 구동됩니다. 모든 곳에서 중지하려면 선택 해제하고, 이후 다시 선택하면 이 페이지에서 구동됩니다.",
    "自動フィードは、このプロジェクトの別のページによって駆動されます。すべてで停止するにはチェックを外してください。その後、再度チェックすると、このページから駆動されます。",
    "يتم تشغيل التغذية التلقائية بواسطة صفحة أخرى في هذا المشروع. قم بإلغاء التحديد لإيقافها في كل مكان؛ قم بالتحديد مرة أخرى لاحقًا لتشغيلها من هذه الصفحة.",
    "L'alimentazione automatica è guidata da un'altra pagina di questo progetto. Deseleziona per fermarla ovunque; selezionala di nuovo dopo per guidarla da questa pagina."
  ],
  [
    "Auto-feed next step",
    "自动喂养下一步",
    "자동 피드 다음 단계",
    "自動フィード次のステップ",
    "الخطوة التالية للتغذية التلقائية",
    "Alimentazione automatica al prossimo passo"
  ],
  [
    "auto-generated",
    "自动生成",
    "auto-생성됨",
    "自動生成",
    "تم إنشاؤه تلقائيًا",
    "generato automaticamente"
  ],
  [
    "Auto-install is Windows-only.",
    "自动安装仅限 Windows。",
    "자동 설치는 Windows 전용입니다.",
    "自動インストールはWindows専用です。",
    "التثبيت التلقائي مخصص لنظام Windows فقط.",
    "L'installazione automatica è solo per Windows."
  ],
  [
    "auto-running /auth — choose Google sign-in, then complete the browser flow.",
    "自动运行 /auth — 选择 Google 登录，然后完成浏览器流程。",
    "자동 실행 /auth — Google 로그인 선택 후 브라우저 흐름 완료.",
    "自動実行 /auth — Googleサインインを選択し、その後ブラウザの手順を完了する。",
    "تشغيل تلقائي /auth — اختر تسجيل الدخول عبر Google، ثم أكمل عملية المتصفح.",
    "esecuzione automatica di /auth — scegli l'accesso con Google, quindi completa il flusso del browser."
  ],
  [
    "auto-running /login — complete the browser sign-in.",
    "自动运行 /login — 完成浏览器登录。",
    "자동 실행 /login — 브라우저 로그인 완료.",
    "自動実行 /login — ブラウザでのサインインを完了する。",
    "تشغيل تلقائي /login — أكمل تسجيل الدخول عبر المتصفح.",
    "esecuzione automatica di /login — completa l'accesso tramite browser."
  ],
  [
    "Auto-start",
    "自动启动",
    "자동 시작",
    "自動起動",
    "التشغيل التلقائي",
    "Avvio automatico"
  ],
  [
    "auto-start {0}: {1}",
    "自动启动 {0}：{1}",
    "auto-start {0}: {1}",
    "自動起動 {0}: {1}",
    "التشغيل التلقائي {0}: {1}",
    "avvio automatico {0}: {1}"
  ],
  [
    "Auto-start OFF — this server only runs when you click Start.",
    "自动启动关闭 — 这个服务器只有在你点击“开始”时才会运行。",
    "자동 시작 OFF — 이 서버는 Start를 클릭할 때만 실행됩니다.",
    "自動起動 OFF — このサーバーは、[開始] をクリックしたときだけ実行されます。",
    "التشغيل التلقائي إيقاف — هذا الخادم يعمل فقط عند النقر على بدء.",
    "Avvio automatico OFF — questo server funziona solo quando clicchi Avvia."
  ],
  [
    "Auto-start ON — this server spins up automatically on the first agent run (or click Start now).",
    "自动启动开启 — 这个服务器会在第一次代理运行时（或立即点击“开始”）自动启动。",
    "자동 시작 ON — 이 서버는 첫 번째 에이전트 실행 시(또는 지금 Start를 클릭할 때) 자동으로 시작됩니다.",
    "自動起動 ON — このサーバーは、最初のエージェント実行時（または今すぐ [開始] をクリック）に自動的に起動します。",
    "التشغيل التلقائي تشغيل — هذا الخادم يتم تشغيله تلقائيًا عند أول تشغيل للوكيل (أو انقر على بدء الآن).",
    "Avvio automatico ON — questo server si avvia automaticamente al primo avvio dell'agente (o cliccando Avvia ora)."
  ],
  [
    "Auto-start on app boot",
    "应用启动时自动启动",
    "앱 시작 시 자동 시작",
    "アプリ起動時に自動起動",
    "التشغيل التلقائي عند تشغيل التطبيق",
    "Avvio automatico all'avvio dell'app"
  ],
  [
    "Auto: OWLLM picks a context window that fits your GPU's VRAM (≈32K on a 24 GB card, less on smaller). Big enough for agentic teams; lower it manually if a model still won't load.",
    "自动：OWLLM 会选择一个适合你 GPU 显存的上下文窗口（24 GB 显卡约为 32K，更小的显卡则更少）。足够用于代理团队；如果模型仍然无法加载，可以手动降低。",
    "자동: OWLLM은 GPU의 VRAM에 맞는 컨텍스트 창을 선택합니다(24GB 카드에서 약 32K, 더 작은 카드에서는 그보다 적음). 에이전트 팀에게 충분히 큽니다; 모델이 여전히 로드되지 않으면 수동으로 줄이세요.",
    "自動: OWLLM は GPU の VRAM に合うコンテキストウィンドウを選択します（24 GB カードで約32K、より小さいカードでは少なめ）。エージェントチームにとって十分な大きさです。モデルがまだ読み込めない場合は手動で下げてください。",
    "تلقائي: يختار OWLLM نافذة السياق التي تناسب ذاكرة VRAM الخاصة بالمعالج الرسومي لديك (≈32K على بطاقة 24 جيجابايت، أقل على البطاقات الأصغر). كبيرة بما يكفي للفرق الوكيلة؛ قللها يدويًا إذا لم يتم تحميل النموذج.",
    "Automatico: OWLLM sceglie una finestra di contesto che si adatta alla VRAM della tua GPU (≈32K su una scheda da 24 GB, meno su schede più piccole). Abbastanza grande per team agentici; riducila manualmente se un modello non si carica ancora."
  ],
  [
    "Autofill login",
    "自动填充登录",
    "자동 로그인",
    "自動ログイン",
    "تعبئة تسجيل الدخول تلقائيًا",
    "Compilazione automatica login"
  ],
  [
    "automatic exchanges",
    "自动交换",
    "자동 교환",
    "自動交換",
    "المبادلات التلقائية",
    "Scambi automatici"
  ],
  [
    "Automatically uses whichever search backend is configured — an",
    "自动使用配置好的任何搜索后端 — 一个",
    "자동으로 구성된 검색 백엔드를 사용합니다 — ",
    "設定されている検索バックエンドを自動的に使用します — これは",
    "يستخدم تلقائيًا أي خلفية بحث تم تكوينها —",
    "Utilizza automaticamente qualsiasi backend di ricerca configurato — un"
  ],
  [
    "available",
    "可用",
    "사용 가능",
    "利用可能",
    "متاح",
    "disponibile"
  ],
  [
    "AVOID",
    "避免",
    "피하기",
    "回避",
    "تجنب",
    "EVITA"
  ],
  [
    "awesome-mcp-servers",
    "awesome-mcp-服务器",
    "awesome-mcp-서버",
    "awesome-mcp-サーバー",
    "awesome-mcp-servers",
    "server-awesome-mcp"
  ],
  [
    "Back to all teams",
    "返回所有团队",
    "모든 팀으로 돌아가기",
    "すべてのチームに戻る",
    "العودة إلى جميع الفرق",
    "Torna a tutti i team"
  ],
  [
    "Back to automatic model choice",
    "返回自动模型选择",
    "자동 모델 선택으로 돌아가기",
    "自動モデル選択に戻る",
    "العودة إلى اختيار النموذج التلقائي",
    "Torna alla scelta automatica del modello"
  ],
  [
    "Back to menu",
    "返回菜单",
    "메뉴로 돌아가기",
    "メニューに戻る",
    "العودة إلى القائمة",
    "Torna al menu"
  ],
  [
    "Back to Start",
    "返回开始",
    "시작으로 돌아가기",
    "開始に戻る",
    "العودة إلى البداية",
    "Torna all'inizio"
  ],
  [
    "Back to the default team model",
    "返回默认团队模型",
    "기본 팀 모델로 돌아가기",
    "デフォルトチームモデルに戻る",
    "العودة إلى نموذج الفريق الافتراضي",
    "Torna al modello del team predefinito"
  ],
  [
    "Back to the project list (your files stay on disk)",
    "返回项目列表（您的文件仍保留在磁盘上）",
    "프로젝트 목록으로 돌아가기 (파일은 디스크에 그대로 유지됨)",
    "プロジェクト一覧に戻る（ファイルはディスクに残ります）",
    "العودة إلى قائمة المشاريع (ملفاتك تبقى على القرص)",
    "Torna alla lista dei progetti (i tuoi file restano sul disco)"
  ],
  [
    "BASE",
    "基础",
    "기본",
    "基本",
    "الأساس",
    "BASE"
  ],
  [
    "Base role",
    "基本角色",
    "기본 역할",
    "基本役割",
    "دور الأساس",
    "Ruolo base"
  ],
  [
    "base:",
    "基础：",
    "기본:",
    "基本:",
    "الأساس:",
    "base:"
  ],
  [
    "bases — a different format from your Chat/Server",
    "基础——与你的聊天/服务器不同的格式",
    "기반 — 당신의 채팅/서버와 다른 형식",
    "ベース — あなたのチャット/サーバーとは異なるフォーマット",
    "الأسس — تنسيق مختلف عن دردشة/خادمك",
    "basi — un formato diverso dal tuo Chat/Server"
  ],
  [
    "bash",
    "Bash",
    "Bash",
    "Bash",
    "باش",
    "Bash"
  ],
  [
    "Bash",
    "Bash",
    "배쉬",
    "バッシュ",
    "باش",
    "Bash"
  ],
  [
    "behave as on a real device — use it to test how a web app looks on mobile.",
    "像在真实设备上一样操作——用它来测试网页应用在移动设备上的显示效果。",
    "실제 장치에서처럼 동작 — 웹 앱이 모바일에서 어떻게 보이는지 테스트하는 데 사용하세요.",
    "実際のデバイスのように動作する — モバイルでウェブアプリがどのように見えるかをテストするために使用する。",
    "تصرّف كما لو كنت على جهاز حقيقي — استخدمه لاختبار شكل تطبيق الويب على الهاتف المحمول.",
    "comportati come su un dispositivo reale — usalo per testare come appare una web app su mobile."
  ],
  [
    "below to keep them.",
    "下面以保存它们。",
    "아래에 유지합니다.",
    "下に保持するため。",
    "أسفل للحفاظ عليها.",
    "Qui sotto per conservarli."
  ],
  [
    "below.",
    "下面。",
    "아래.",
    "下。",
    "أسفل.",
    "Sotto."
  ],
  [
    "below. It will be stored in",
    "下面。它将被存储在",
    "아래. 그것은 저장될 것입니다",
    "下。これはに保存されます",
    "أسفل. سيتم تخزينه في",
    "Sotto. Sarà conservato in"
  ],
  [
    "BF16",
    "BF16",
    "BF16",
    "BF16",
    "BF16",
    "BF16"
  ],
  [
    "binary",
    "二进制",
    "이진",
    "バイナリ",
    "ثنائي",
    "binario"
  ],
  [
    "Blue",
    "蓝色",
    "파랑",
    "青",
    "أزرق",
    "Blu"
  ],
  [
    "boot_key: {\"key\": string} — mount_iso: {\"isoPath\": string} — power: {\"line\": \"power\"|\"reset\"}.",
    "boot_key: {\"key\": string} — mount_iso: {\"isoPath\": string} — power: {\"line\": \"power\"|\"reset\"}。",
    "boot_key: {\"key\": string} — mount_iso: {\"isoPath\": string} — power: {\"line\": \"power\"|\"reset\"}.",
    "boot_key: {\"key\": string} — mount_iso: {\"isoPath\": string} — power: {\"line\": \"power\"|\"reset\"}。",
    "boot_key: {\"key\": string} — mount_iso: {\"isoPath\": string} — power: {\"line\": \"power\"|\"reset\"}.",
    "boot_key: {\"key\": string} — mount_iso: {\"isoPath\": string} — power: {\"line\": \"power\"|\"reset\"}."
  ],
  [
    "Bot token · gateway WebSocket · no public URL needed",
    "机器人令牌 · 网关 WebSocket · 不需要公共 URL",
    "봇 토큰 · 게이트웨이 WebSocket · 공개 URL 필요 없음",
    "ボットトークン · ゲートウェイWebSocket · 公開URLは不要",
    "رمز البوت · WebSocket البوابة · لا حاجة لعنوان URL عام",
    "Token del bot · WebSocket del gateway · nessun URL pubblico necessario"
  ],
  [
    "Bot token from @BotFather · long-poll · no public URL needed",
    "来自 @BotFather 的机器人令牌 · 长轮询 · 不需要公共 URL",
    "@BotFather로부터 가져온 봇 토큰 · 롱폴링 · 공개 URL 필요 없음",
    "@BotFatherからのボットトークン · ロングポーリング · 公開URLは不要",
    "رمز البوت من @BotFather · استدعاء طويل · لا حاجة لعنوان URL عام",
    "Token del bot da @BotFather · long-poll · nessun URL pubblico necessario"
  ],
  [
    "Bot token from the Developer Portal",
    "来自开发者门户的机器人令牌",
    "개발자 포털에서의 봇 토큰",
    "開発者ポータルからのボットトークン",
    "رمز البوت من بوابة المطور",
    "Token del bot dal Developer Portal"
  ],
  [
    "Bot token from your Slack app (starts with xoxb-). Create a new app at api.slack.com/apps.",
    "来自你的 Slack 应用的机器人令牌（以 xoxb- 开头）。在 api.slack.com/apps 创建一个新应用。",
    "Slack 앱에서의 봇 토큰(xoxb-로 시작). api.slack.com/apps에서 새 앱 생성",
    "Slackアプリからのボットトークン（xoxb-で始まります）。api.slack.com/appsで新しいアプリを作成してください。",
    "رمز البوت من تطبيق Slack الخاص بك (يبدأ بـ xoxb-). أنشئ تطبيقًا جديدًا على api.slack.com/apps.",
    "Token del bot dalla tua app Slack (inizia con xoxb-). Crea una nuova app su api.slack.com/apps."
  ],
  [
    "bot@example.com",
    "bot@example.com",
    "bot@example.com",
    "bot@example.com",
    "bot@example.com",
    "bot@example.com"
  ],
  [
    "Brainstorm needs a project folder — click to open Project settings and set one",
    "Brainstorm 需要一个项目文件夹 — 点击打开项目设置并设置一个",
    "브레인스토밍에는 프로젝트 폴더가 필요함 — 프로젝트 설정을 열고 하나 설정하려면 클릭",
    "ブレインストームにはプロジェクトフォルダが必要 — プロジェクト設定を開いて設定してください",
    "العصف الذهني يحتاج إلى مجلد مشروع — انقر لفتح إعدادات المشروع وتعيينه",
    "Brainstorm ha bisogno di una cartella di progetto — clicca per aprire le impostazioni del Progetto e impostarla"
  ],
  [
    "Brainstorm: co-founder chat → research → BRIEF.md before the team runs",
    "Brainstorm: 联合创始人聊天 → 研究 → 团队运行前的 BRIEF.md",
    "브레인스토밍: 공동 창립자 채팅 → 연구 → 팀이 진행하기 전에 BRIEF.md",
    "ブレインストーム: 共同創設者チャット → リサーチ → チームが実行する前にBRIEF.md",
    "العصف الذهني: دردشة المؤسس المشارك → البحث → BRIEF.md قبل أن يقوم الفريق بالتنفيذ",
    "Brainstorm: chat del co-fondatore → ricerca → BRIEF.md prima che inizi il team"
  ],
  [
    "Brainstormer role not loaded (resources/agents/roles/brainstormer.yaml).",
    "Brainstormer 角色未加载（resources/agents/roles/brainstormer.yaml）。",
    "브레인스토머 역할이 로드되지 않았습니다 (resources/agents/roles/brainstormer.yaml).",
    "Brainstormer役割がロードされていません (resources/agents/roles/brainstormer.yaml)。",
    "دور العصف الذهني غير محمّل (resources/agents/roles/brainstormer.yaml).",
    "Ruolo di Brainstormer non caricato (resources/agents/roles/brainstormer.yaml)."
  ],
  [
    "Branch",
    "分支",
    "브랜치",
    "ブランチ",
    "فرع",
    "Ramo"
  ],
  [
    "Branch: {0}{1}{2}{3}",
    "分支：{0}{1}{2}{3}",
    "브랜치: {0}{1}{2}{3}",
    "ブランチ: {0}{1}{2}{3}",
    "فرع: {0}{1}{2}{3}",
    "Ramo: {0}{1}{2}{3}"
  ],
  [
    "brave-search",
    "brave-搜索",
    "브레이브-검색",
    "brave-search",
    "بحث شجاع",
    "brave-search"
  ],
  [
    "Break the goal into ordered steps, then build them one by one (Kanban)",
    "将目标拆分为有序步骤，然后逐一构建（看板）",
    "목표를 순서화된 단계로 나눈 후, 하나씩 구축하세요 (칸반)",
    "目標を順序付けたステップに分解し、次にそれらを一つずつ構築します（カンバン）",
    "قسّم الهدف إلى خطوات مرتبة، ثم ابنها واحدة تلو الأخرى (كانبان)",
    "Dividi l'obiettivo in passaggi ordinati, poi costruiscili uno per uno (Kanban)"
  ],
  [
    "brew install whisper-cpp",
    "brew 安装 whisper-cpp",
    "brew install whisper-cpp",
    "brew install whisper-cpp",
    "brew تثبيت whisper-cpp",
    "brew install whisper-cpp"
  ],
  [
    "Bridge Control",
    "桥接控制",
    "브리지 제어",
    "ブリッジコントロール",
    "التحكم في الجسر",
    "Controllo del Ponte"
  ],
  [
    "Bridges",
    "桥梁",
    "브리지들",
    "ブリッジ",
    "الجسور",
    "Ponti"
  ],
  [
    "broken",
    "损坏",
    "손상됨",
    "壊れた",
    "معطل",
    "danneggiato"
  ],
  [
    "BROKEN",
    "破损",
    "부서진",
    "壊れた",
    "مكسور",
    "ROTTO"
  ],
  [
    "Browsable web directory with categories, ratings, and one-click install configs.",
    "可浏览的网页目录，带有分类、评分和一键安装配置。",
    "카테고리, 평가, 원클릭 설치 구성과 함께 탐색 가능한 웹 디렉토리.",
    "閲覧可能なウェブディレクトリ。カテゴリ、評価、ワンクリックインストール設定付き。",
    "دليل ويب قابل للتصفح مع فئات وتصنيفات وتهيئات تثبيت بنقرة واحدة.",
    "Directory web navigabile con categorie, valutazioni e configurazioni di installazione con un clic."
  ],
  [
    "browse",
    "浏览",
    "탐색",
    "閲覧",
    "تصفح",
    "Naviga"
  ],
  [
    "Browse",
    "浏览",
    "둘러보기",
    "閲覧",
    "تصفح",
    "Sfoglia"
  ],
  [
    "Browse output directory",
    "浏览输出目录",
    "출력 디렉토리 탐색",
    "出力ディレクトリを閲覧",
    "تصفح دليل المخرجات",
    "Sfoglia la directory di output"
  ],
  [
    "Browse the full MCP universe",
    "浏览完整的MCP宇宙",
    "전체 MCP 유니버스 탐색",
    "MCP ユニバース全体を閲覧",
    "تصفح الكون الكامل MCP",
    "Sfoglia l'universo completo di MCP"
  ],
  [
    "Browse…",
    "浏览…",
    "찾아보기…",
    "参照…",
    "تصفح…",
    "Sfoglia…"
  ],
  [
    "browser_get_text to read page content.",
    "browser_get_text 用于读取页面内容。",
    "browser_get_text로 페이지 내용을 읽습니다.",
    "browser_get_textでページ内容を読む。",
    "browser_get_text لقراءة محتوى الصفحة.",
    "browser_get_text per leggere il contenuto della pagina."
  ],
  [
    "browser_snapshot. Snapshot first to get the index.",
    "browser_snapshot。先截图以获取索引。",
    "browser_snapshot. 먼저 스냅샷을 찍어 인덱스를 얻습니다.",
    "browser_snapshot。まずスナップショットを取ってインデックスを取得。",
    "browser_snapshot. التقط لقطة أولاً للحصول على الفهرس.",
    "browser_snapshot. Prima fai uno snapshot per ottenere l'indice."
  ],
  [
    "BSA…",
    "BSA…",
    "BSA…",
    "BSA…",
    "BSA…",
    "BSA…"
  ],
  [
    "bug",
    "错误",
    "버그",
    "バグ",
    "خطأ",
    "bug"
  ],
  [
    "Build mode",
    "构建模式",
    "빌드 모드",
    "ビルドモード",
    "وضع البناء",
    "Modalità di costruzione"
  ],
  [
    "Build your own",
    "自行构建",
    "직접 빌드",
    "自分で構築",
    "ابنِ بنفسك",
    "Costruisci il tuo"
  ],
  [
    "Build, sign, and publish a signed OwLLM release on the HOST (runs the vetted",
    "在HOST上构建、签名并发布签名的OwLLM版本（运行经过审核的",
    "서명된 OwLLM 릴리스를 HOST에서 빌드, 서명 및 게시합니다 (검증된",
    "HOSTで署名されたOwLLMリリースを構築、署名、公開（検証済みで実行）",
    "ابنِ ووقّع وانشر إصدار OwLLM الموقع على المضيف (يشغل النسخ التي تم التحقق منها",
    "Costruisci, firma e pubblica una release OwLLM firmata sull'HOST (esegue la verifica"
  ],
  [
    "builds and signs the release on this machine (needs the build toolchain + cert here).",
    "在这台机器上构建和签名版本（需要此处的构建工具链 + 证书）。",
    "이 컴퓨터에서 릴리스를 빌드하고 서명합니다 (여기서 빌드 툴체인 + 인증서 필요).",
    "このマシンでリリースをビルドして署名します（ここにビルドツールチェーンと証明書が必要です）。",
    "يبني ويوقّع الإصدار على هذه الآلة (يحتاج إلى سلسلة أدوات البناء + الشهادة هنا).",
    "builds e firma la release su questa macchina (serve la toolchain di build + certificato qui)."
  ],
  [
    "Built-in",
    "内建",
    "내장",
    "組み込み",
    "مضمّن",
    "INTEGRATO"
  ],
  [
    "BUILT-IN",
    "内置",
    "내장",
    "内蔵",
    "مُدمج",
    "INTEGRATO"
  ],
  [
    "built-in · Save edits it in place (as an override)",
    "内置 · 将编辑保存到原位（作为覆盖）",
    "내장 · 편집 내용을 제자리에서 저장(재정의로)",
    "組み込み · 編集内容をその場で保存（オーバーライドとして）",
    "مُدمج · احفظ التعديلات في مكانها (ككتابة فوق)",
    "built-in · Salva le modifiche sul posto (come un override)"
  ],
  [
    "Built-in agent — Duplicate it first to give your copy skills.",
    "内置代理 — 首先复制它以赋予你的副本技能。",
    "내장 에이전트 — 복제한 후에야 복사 기능을 사용할 수 있습니다.",
    "組み込みエージェント — まずそれを複製して、コピーのスキルを付与してください。",
    "وكيل مدمج — انسخه أولاً لتتمكن من استخدام مهارات نسختك.",
    "Agente integrato — Dupicalo prima per dare le tue capacità di copia."
  ],
  [
    "Built-in best practice — edit or delete it like any rule",
    "内置最佳实践 — 像编辑或删除任何规则一样处理它",
    "내장된 모범 사례 — 다른 규칙처럼 편집하거나 삭제하세요",
    "組み込みのベストプラクティス — 他のルールと同じように編集または削除できます",
    "أفضل ممارسة مدمجة — قم بتحريرها أو حذفها مثل أي قاعدة",
    "Best practice incorporata — modificarla o eliminarla come qualsiasi regola"
  ],
  [
    "Built-in tools",
    "内置工具",
    "내장 도구",
    "組み込みツール",
    "أدوات مدمجة",
    "Strumenti integrati"
  ],
  [
    "builtin",
    "内置",
    "내장",
    "組み込み",
    "مضمن",
    "builtin"
  ],
  [
    "Bump the version in tauri.conf.json, commit, push and tag FIRST, then call this.",
    "先在 tauri.conf.json 中提升版本，提交、推送并打标签，然后调用此操作。",
    "tauri.conf.json에서 버전을 올리고, 커밋한 다음, 푸시하고 태그를 먼저 한 후 이것을 호출하세요.",
    "最初に tauri.conf.json のバージョンを上げ、コミット、プッシュ、タグ付けしてからこれを呼び出してください。",
    "قم بزيادة الإصدار في tauri.conf.json، ثم قم بالالتزام، الدفع، وإضافة العلامة أولاً، ثم قم باستدعاء هذا.",
    "Aggiorna la versione in tauri.conf.json, esegui commit, push e tag PRIMA, poi chiama questo."
  ],
  [
    "By status",
    "按状态",
    "상태별",
    "ステータス別",
    "حسب الحالة",
    "Per stato"
  ],
  [
    "C:/path/to/gcp-oauth.keys.json",
    "C:/path/to/gcp-oauth.keys.json",
    "C:/path/to/gcp-oauth.keys.json",
    "C:/path/to/gcp-oauth.keys.json",
    "C:/path/to/gcp-oauth.keys.json",
    "C:/percorso/a/gcp-oauth.keys.json"
  ],
  [
    "cache",
    "缓存",
    "캐시",
    "キャッシュ",
    "الذاكرة المؤقتة",
    "Cache"
  ],
  [
    "Cache",
    "缓存",
    "캐시",
    "キャッシュ",
    "ذاكرة التخزين المؤقت",
    "Cache"
  ],
  [
    "Call this when the task matches a skill whose body you haven't loaded",
    "当任务匹配你还没有加载的技能主体时调用此操作",
    "작업이 아직 불러오지 않은 스킬의 본문과 일치할 때 이것을 호출하세요",
    "タスクがまだ読み込んでいないスキルのボディに一致する場合はこれを呼び出します",
    "قم باستدعاء هذا عندما تتطابق المهمة مع مهارة لم تقم بتحميل محتواها بعد",
    "Chiama questo quando il compito corrisponde a una competenza il cui corpo non hai caricato"
  ],
  [
    "Can dispatch",
    "可以分派",
    "디스패치 가능",
    "ディスパッチ可能",
    "يمكن توزيعها",
    "Può distribuire"
  ],
  [
    "Can this agent dispatch sub-tasks to OTHER agents? Orchestrators (and Team Leaders) need this on. Specialists usually leave it off so they focus on their own job and don't fan out work.",
    "这个代理可以将子任务分派给其他代理吗？协调者（和团队负责人）需要开启这个功能。专家通常会关闭它，以便专注于自己的工作，而不扩散任务。",
    "이 에이전트가 다른 에이전트에게 하위 작업을 디스패치할 수 있나요? 오케스트레이터(및 팀 리더)는 이것을 켜야 합니다. 전문가들은 보통 자신의 작업에 집중하고 일을 확산시키지 않기 위해 끔으로 유지합니다.",
    "このエージェントはサブタスクを他のエージェントにディスパッチできますか？オーケストレーター（およびチームリーダー）はこれをオンにする必要があります。スペシャリストは通常、自分の仕事に集中し、仕事を拡散させないようにオフにします。",
    "هل يمكن لهذا الوكيل توزيع المهام الفرعية إلى وكلاء آخرين؟ يحتاج المنسقون (ورؤساء الفرق) إلى تفعيل هذا. عادةً يتركه المتخصصون مغلقًا للتركيز على عملهم الخاص وعدم توزيع العمل.",
    "Questo agente può distribuire sotto-compiti ad ALTRI agenti? Gli orchestratori (e i Team Leader) hanno bisogno che sia attivo. Gli specialisti di solito lo lasciano spento in modo da concentrarsi sul proprio lavoro e non distribuire ulteriormente il lavoro."
  ],
  [
    "Can't save: no path on disk (built-in role or unloaded). Click Duplicate first.",
    "无法保存：磁盘上没有路径（内置角色或未加载）。请先点击“复制”。",
    "저장 불가: 디스크에 경로가 없음(내장 역할 또는 언로드). 먼저 복제를 클릭하세요.",
    "保存できません：ディスクにパスがありません（組み込みロールまたは未読み込み）。まず「複製」をクリックしてください。",
    "لا يمكن الحفظ: لا يوجد مسار على القرص (دور مدمج أو غير محمل). انقر فوق نسخ أولاً.",
    "Impossibile salvare: nessun percorso sul disco (ruolo incorporato o non caricato). Clicca prima su Duplica."
  ],
  [
    "cancel",
    "取消",
    "취소",
    "キャンセル",
    "إلغاء",
    "Annulla"
  ],
  [
    "Cancel",
    "取消",
    "취소",
    "キャンセル",
    "إلغاء",
    "Annulla"
  ],
  [
    "Capture this app window and ask the model about what's on screen.",
    "捕获此应用窗口并向模型询问屏幕上的内容。",
    "이 앱 창을 캡처하고 모델에게 화면에 무엇이 있는지 물어보세요.",
    "このアプリウィンドウをキャプチャし、画面上の内容についてモデルに問い合わせます。",
    "التقاط نافذة هذا التطبيق واسأل النموذج عن ما على الشاشة.",
    "Cattura questa finestra dell'app e chiedi al modello cosa c'è sullo schermo."
  ],
  [
    "Card colour",
    "卡片颜色",
    "카드 색상",
    "カードの色",
    "لون البطاقة",
    "Colore della scheda"
  ],
  [
    "Category",
    "类别",
    "카테고리",
    "カテゴリー",
    "الفئة",
    "Categoria"
  ],
  [
    "Cert thumbprint (SHA-1)",
    "证书指纹（SHA-1）",
    "인증 엄지 지문 (SHA-1)",
    "証明書のサムプリント（SHA-1）",
    "بصمة الشهادة (SHA-1)",
    "Impronta digitale del certificato (SHA-1)"
  ],
  [
    "Certificate password",
    "证书密码",
    "인증서 비밀번호",
    "証明書のパスワード",
    "كلمة مرور الشهادة",
    "Password del certificato"
  ],
  [
    "Change res VRAM",
    "更改剩余显存",
    "변경 res VRAM",
    "VRAMを変更",
    "تغيير VRAM للإعداد",
    "Cambia VRAM res"
  ],
  [
    "Characters",
    "字符",
    "등장인물",
    "文字",
    "الشخصيات",
    "Caratteri"
  ],
  [
    "Characters carried between chunks",
    "跨块携带的字符",
    "캐릭터 이동 중 하나",
    "チャンク間で運ばれる文字",
    "الشخصيات المنقولة بين الأجزاء",
    "Caratteri trasportati tra i blocchi"
  ],
  [
    "chars)",
    "字符)",
    "캐릭터)",
    "文字)",
    "أحرف)",
    "caratteri)"
  ],
  [
    "chat",
    "聊天",
    "대화",
    "チャット",
    "دردشة",
    "Chat"
  ],
  [
    "Chat",
    "聊天",
    "채팅",
    "チャット",
    "دردشة",
    "Chat"
  ],
  [
    "Chat grid",
    "聊天网格",
    "채팅 그리드",
    "チャットグリッド",
    "شبكة الدردشة",
    "Griglia chat"
  ],
  [
    "check",
    "检查",
    "체크",
    "チェック",
    "تحقق",
    "controlla"
  ],
  [
    "Checking which environments are installed…",
    "正在检查已安装的环境…",
    "어떤 환경이 설치되어 있는지 확인 중…",
    "どの環境がインストールされているかを確認しています…",
    "التحقق من البيئات المثبتة…",
    "Verifica di quali ambienti sono installati…"
  ],
  [
    "Checking...",
    "检查中...",
    "확인 중...",
    "確認中…",
    "جارٍ التحقق...",
    "Verifica..."
  ],
  [
    "Checking…",
    "检查中…",
    "확인 중…",
    "確認中…",
    "جارٍ الفحص…",
    "Controllo…"
  ],
  [
    "Choose any accent color",
    "选择任意强调色",
    "원하는 강조 색상 선택",
    "任意のアクセントカラーを選択",
    "اختر أي لون لهجة",
    "Scegli un colore di accento"
  ],
  [
    "Choose weights to download",
    "选择要下载的权重",
    "다운로드할 가중치 선택",
    "ダウンロードするウェイトを選択",
    "اختر الأوزان للتحميل",
    "Scegli i pesi da scaricare"
  ],
  [
    "Choose your certificate (.p12 from Keychain, or the .cer Apple downloads)",
    "选择您的证书（来自钥匙串的 .p12，或 Apple 下载的 .cer）",
    "인증서 선택 (.p12는 키체인에서, 또는 .cer는 Apple 다운로드에서)",
    "証明書を選択（Keychainからの.p12、またはAppleがダウンロードする.cer）",
    "اختر شهادتك (.p12 من سلسلة المفاتيح، أو .cer من تنزيلات Apple)",
    "Scegli il tuo certificato (.p12 da Portachiavi, o il .cer scaricato da Apple)"
  ],
  [
    "Chunk size",
    "块大小",
    "청크 크기",
    "チャンクサイズ",
    "حجم القطعة",
    "Dimensione del blocco"
  ],
  [
    "CI / GitHub Actions",
    "CI / GitHub Actions",
    "CI / GitHub Actions",
    "CI / GitHub Actions",
    "CI / إجراءات GitHub",
    "CI / Azioni GitHub"
  ],
  [
    "CI / GitHub Actions — push tag, let workflow build",
    "CI / GitHub Actions — 推送标签，让工作流构建",
    "CI / GitHub Actions — 태그 푸시, 워크플로 빌드 허용",
    "CI / GitHub Actions — タグをプッシュして、ワークフローにビルドさせる",
    "CI / GitHub Actions — دفع العلامة، دع سير العمل يبني",
    "CI / GitHub Actions — invia tag, lascia che il flusso di lavoro costruisca"
  ],
  [
    "CI mode",
    "CI 模式",
    "CI 모드",
    "CIモード",
    "وضع CI",
    "Modalità CI"
  ],
  [
    "Classic token with the",
    "经典令牌，带有",
    "클래식 토큰과 함께",
    "クラシックトークンで",
    "رمز كلاسيكي مع",
    "Token classico con il"
  ],
  [
    "clear",
    "清除",
    "지우기",
    "クリア",
    "مسح",
    "Chiaro"
  ],
  [
    "Clear",
    "清除",
    "깨끗한",
    "クリア",
    "واضح",
    "Chiaro"
  ],
  [
    "Clear all transcripts",
    "清除所有记录",
    "모든 기록 지우기",
    "すべてのトランスクリプトをクリア",
    "مسح كل النصوص",
    "Cancella tutte le trascrizioni"
  ],
  [
    "Clear history",
    "清除历史记录",
    "히스토리 지우기",
    "履歴をクリア",
    "مسح السجل",
    "Cancella cronologia"
  ],
  [
    "Clear notes",
    "清除笔记",
    "노트 지우기",
    "ノートをクリア",
    "مسح الملاحظات",
    "Cancella appunti"
  ],
  [
    "Clear search",
    "清除搜索",
    "검색 지우기",
    "検索をクリア",
    "مسح البحث",
    "Cancella ricerca"
  ],
  [
    "Clear the chat window and all saved chat history",
    "清除聊天窗口和所有保存的聊天记录",
    "채팅 창과 모든 저장된 채팅 기록 지우기",
    "チャットウィンドウと保存されたすべてのチャット履歴をクリア",
    "مسح نافذة الدردشة وكل سجل الدردشة المحفوظ",
    "Cancella la finestra della chat e tutta la cronologia salvata della chat"
  ],
  [
    "Clear the chat window and all saved chat history? This cannot be undone.",
    "清除聊天窗口和所有保存的聊天记录？此操作无法撤销。",
    "채팅 창과 모든 저장된 채팅 기록을 지우시겠습니까? 이 동작은 취소할 수 없습니다.",
    "チャットウィンドウと保存されたすべてのチャット履歴をクリアしますか？これは元に戻せません。",
    "مسح نافذة الدردشة وكل سجل الدردشة المحفوظ؟ لا يمكن التراجع عن هذا.",
    "Cancella la finestra della chat e tutta la cronologia salvata della chat? Questa operazione non può essere annullata."
  ],
  [
    "Clear the current run (tasks, drafts and run state) but keep the chat",
    "清除当前运行（任务、草稿和运行状态），但保留聊天内容",
    "현재 실행(작업, 초안 및 실행 상태)을 지우고 채팅은 유지",
    "現在の実行（タスク、下書き、実行状態）をクリアしますが、チャットは保持します",
    "مسح التشغيل الحالي (المهام، المسودات وحالة التشغيل) مع الحفاظ على الدردشة",
    "Cancella l'esecuzione corrente (compiti, bozze e stato di esecuzione) ma conserva la chat"
  ],
  [
    "Clear the draft text",
    "清除草稿内容",
    "초안 텍스트 지우기",
    "下書きテキストをクリアします",
    "مسح نص المسودة",
    "Cancella il testo della bozza"
  ],
  [
    "Clear this conversation",
    "清除此对话",
    "이 대화 지우기",
    "この会話をクリアします",
    "مسح هذه المحادثة",
    "Cancella questa conversazione"
  ],
  [
    "Clear this conversation and its saved checkpoint to start a new idea",
    "清除此对话及其保存的检查点以开始一个新想法",
    "이 대화와 저장된 체크포인트를 지우고 새 아이디어 시작",
    "この会話と保存されたチェックポイントをクリアして、新しいアイデアを開始します",
    "مسح هذه المحادثة ونقطة الحفظ المحفوظة لبدء فكرة جديدة",
    "Cancella questa conversazione e il suo checkpoint salvato per iniziare una nuova idea"
  ],
  [
    "Clear working notes and start a fresh note",
    "清除工作笔记并开始一个新的笔记",
    "작업 노트를 지우고 새로운 노트 시작",
    "作業メモをクリアして、新しいメモを始めます",
    "مسح الملاحظات الجارية وبدء ملاحظة جديدة",
    "Cancella appunti di lavoro e inizia un nuovo appunto"
  ],
  [
    "CLI logged in",
    "CLI 已登录",
    "CLI 로그인됨",
    "CLIにログインしました",
    "تم تسجيل الدخول إلى CLI",
    "CLI connesso"
  ],
  [
    "CLI not installed / logged in",
    "CLI 未安装 / 未登录",
    "CLI 설치되지 않음 / 로그인되지 않음",
    "CLIがインストールされていない / ログインしていません",
    "CLI غير مثبت / لم يتم تسجيل الدخول",
    "CLI non installato / non connesso"
  ],
  [
    "CLI signed in; otherwise use",
    "CLI 已登录；否则请使用",
    "CLI에 로그인됨; 그렇지 않으면 사용",
    "CLIにサインインしました。そうでない場合は使用してください",
    "تم تسجيل الدخول عبر CLI؛ وإلا استخدم",
    "CLI effettuato l'accesso; altrimenti usa"
  ],
  [
    "Click 'Get Started' → sign up → 'Subscriptions' → 'Free' plan → 'API Keys' tab.",
    "点击“开始使用” → 注册 → “订阅” → “免费”计划 → “API 密钥”标签。",
    "'시작하기' 클릭 → 가입 → '구독' → '무료' 플랜 → 'API 키' 탭.",
    "「Get Started」をクリック → サインアップ → 「Subscriptions」 → 「Free」プラン → 「API Keys」タブ。",
    "انقر على 'ابدأ' → سجّل → 'الاشتراكات' → خطة 'مجانية' → علامة التبويب 'مفاتيح API'.",
    "Clicca su 'Inizia' → registrati → 'Abbonamenti' → piano 'Gratuito' → scheda 'Chiavi API'."
  ],
  [
    "Click + drag to select, then Ctrl-C to copy. Or use 'Copy API URL' below.",
    "点击 + 拖动以选择，然后按 Ctrl-C 复制。或者使用下面的“复制 API URL”。",
    "클릭 후 드래그하여 선택한 뒤 Ctrl-C로 복사. 또는 아래 'API URL 복사' 사용.",
    "クリックしてドラッグで選択し、Ctrl-Cでコピーします。または下の『API URLをコピー』を使用してください。",
    "انقر واسحب لتحديد، ثم Ctrl-C للنسخ. أو استخدم 'نسخ رابط API' أدناه.",
    "Clicca e trascina per selezionare, poi Ctrl-C per copiare. Oppure usa 'Copia URL API' qui sotto."
  ],
  [
    "Click a model card on the left to see its details here.",
    "点击左侧的模型卡，在此处查看其详细信息。",
    "왼쪽의 모델 카드를 클릭하면 여기에 세부 정보를 볼 수 있습니다.",
    "左側のモデルカードをクリックすると、その詳細がここに表示されます。",
    "انقر على بطاقة نموذج على اليسار لرؤية تفاصيلها هنا.",
    "Clicca su una scheda del modello a sinistra per vedere i suoi dettagli qui."
  ],
  [
    "Click a skill on the left to see what it does,",
    "点击左侧的技能查看其功能，",
    "왼쪽에서 스킬을 클릭하면 해당 기능을 볼 수 있습니다,",
    "左側のスキルをクリックすると、何をするかを見ることができます。",
    "انقر على مهارة على اليسار لرؤية ما تفعله،",
    "Clicca su una skill a sinistra per vedere cosa fa,"
  ],
  [
    "Click a skill to preview its SKILL.md",
    "点击技能以预览其 SKILL.md",
    "스킬을 클릭하면 SKILL.md를 미리 볼 수 있습니다.",
    "スキルをクリックして、その SKILL.md をプレビューしてください",
    "انقر على مهارة لمعاينة ملف SKILL.md الخاص بها",
    "Clicca su una skill per visualizzare in anteprima il suo SKILL.md"
  ],
  [
    "Click an agent on the canvas to see its info here.",
    "点击画布上的代理以在此查看其信息。",
    "캔버스에서 에이전트를 클릭하면 여기에 정보가 표시됩니다.",
    "キャンバス上のエージェントをクリックすると、ここにその情報が表示されます。",
    "انقر على وكيل على اللوحة لرؤية معلوماته هنا.",
    "Clicca su un agente sulla tela per vedere le sue informazioni qui."
  ],
  [
    "Click an agent on the left to inspect or edit it.",
    "点击左侧的代理以查看或编辑它。",
    "왼쪽에서 에이전트를 클릭하여 검사하거나 편집합니다.",
    "左側のエージェントをクリックして、確認または編集してください。",
    "انقر على وكيل على اليسار لتفقده أو تعديله.",
    "Clicca su un agente a sinistra per ispezionarlo o modificarlo."
  ],
  [
    "click any to pre-fill the Add dialog",
    "点击任意项以预填添加对话框",
    "아무거나 클릭하면 추가 대화 상자가 미리 채워집니다.",
    "任意をクリックして追加ダイアログを事前入力します。",
    "انقر على أي عنصر لملء مربع الحوار 'إضافة' مسبقًا",
    "clicca su qualsiasi elemento per precompilare la finestra Aggiungi"
  ],
  [
    "Click Connect on any CLI-backed subscription to open a live terminal here.",
    "点击任何基于 CLI 的订阅的连接以在此打开实时终端。",
    "CLI 지원 구독에서 '연결'을 클릭하여 여기에서 라이브 터미널을 엽니다.",
    "CLI対応のサブスクリプションの「接続」をクリックして、ここでライブターミナルを開きます。",
    "انقر على 'اتصال' على أي اشتراك مدعوم من CLI لفتح محطة حيّة هنا.",
    "Clicca Connetti su qualsiasi abbonamento supportato dalla CLI per aprire un terminale live qui."
  ],
  [
    "Click Fetch / refresh to clone this source and discover skills.",
    "点击获取/刷新以克隆此源并发现技能。",
    "가져오기 / 새로고침을 클릭하여 이 소스를 복제하고 스킬을 발견하세요.",
    "「取得／更新」をクリックして、このソースをクローンし、スキルを確認します。",
    "انقر على جلب / تحديث لنسخ هذا المصدر واكتشاف المهارات.",
    "Clicca Recupera / aggiorna per clonare questa fonte e scoprire abilità."
  ],
  [
    "Click the interactive element at the given index from the latest browser_snapshot.",
    "点击从最新的 browser_snapshot 中给定索引的交互元素。",
    "최신 브라우저 스냅샷에서 지정된 인덱스의 인터랙티브 요소를 클릭하세요.",
    "最新の browser_snapshot から指定されたインデックスのインタラクティブ要素をクリックします。",
    "انقر على العنصر التفاعلي عند الفهرس المحدد من أحدث لقطة للمتصفح.",
    "Clicca sull'elemento interattivo all'indice fornito nell'ultimo browser_snapshot."
  ],
  [
    "Click to change icon",
    "点击以更改图标",
    "아이콘 변경을 클릭하세요",
    "アイコンを変更するにはクリックします。",
    "انقر لتغيير الرمز",
    "Clicca per cambiare icona"
  ],
  [
    "click to dismiss",
    "点击以关闭",
    "닫기를 클릭하세요",
    "閉じるにはクリックします。",
    "انقر للإغلاق",
    "clicca per chiudere"
  ],
  [
    "Click to edit",
    "点击以编辑",
    "편집하려면 클릭하세요",
    "編集するにはクリックします。",
    "انقر للتحرير",
    "Clicca per modificare"
  ],
  [
    "Click to enable this GPU for inference",
    "点击以启用此 GPU 进行推理",
    "이 GPU를 추론에 사용하도록 활성화하려면 클릭하세요",
    "この GPU を推論に使用するにはクリックします。",
    "انقر لتمكين هذه وحدة معالجة الرسوميات للاستنتاج",
    "Clicca per abilitare questa GPU per l'inferenza"
  ],
  [
    "Click to expand · Ctrl+A selects this box",
    "点击展开 · Ctrl+A 选择此框",
    "확장하려면 클릭 · Ctrl+A를 눌러 이 상자를 선택",
    "クリックして展開 · Ctrl+Aでこのボックスを選択",
    "انقر للتوسيع · Ctrl+A يحدد هذا الصندوق",
    "Clicca per espandere · Ctrl+A seleziona questa casella"
  ],
  [
    "Click to open the full log",
    "点击以打开完整日志",
    "전체 로그를 열려면 클릭하세요",
    "完全なログを開くにはクリックします。",
    "انقر لفتح السجل الكامل",
    "Clicca per aprire il registro completo"
  ],
  [
    "Click to pick a different icon for this agent",
    "点击选择此代理的不同图标",
    "이 에이전트의 다른 아이콘을 선택하려면 클릭하세요",
    "このエージェントの別のアイコンを選択するにはクリックしてください",
    "انقر لاختيار رمز مختلف لهذا الوكيل",
    "Clicca per scegliere un'icona diversa per questo agente"
  ],
  [
    "Click to view {0}'s chat — click the name to edit model · colour · prompt",
    "点击查看 {0} 的聊天 — 点击名称以编辑模型 · 颜色 · 提示",
    "{0}의 채팅을 보려면 클릭 — 이름을 클릭하여 모델 · 색상 · 프롬프트 편집",
    "{0}のチャットを見るにはクリック — 名前をクリックしてモデル・色・プロンプトを編集",
    "انقر لعرض دردشة {0} — انقر الاسم لتحرير النموذج · اللون · الموجه",
    "Clicca per vedere la chat di {0} — clicca sul nome per modificare modello · colore · prompt"
  ],
  [
    "Clone or fast-forward the source",
    "克隆或快进源",
    "소스를 복제하거나 빨리 감기",
    "ソースをクローンまたは進める",
    "نسخ أو تقديم المصدر بسرعة",
    "Clona o avanza velocemente la fonte"
  ],
  [
    "Close",
    "关闭",
    "닫기",
    "閉じる",
    "إغلاق",
    "Chiudi"
  ],
  [
    "Close (ends the shell)",
    "关闭（结束 shell）",
    "닫기 (셸 종료)",
    "閉じる（シェルを終了）",
    "إغلاق (ينهي الصدفة)",
    "Chiudi (termina la shell)"
  ],
  [
    "Close (Esc)",
    "关闭（Esc）",
    "닫기 (Esc)",
    "閉じる（Esc）",
    "إغلاق (Esc)",
    "Chiudi (Esc)"
  ],
  [
    "Close (or click empty canvas)",
    "关闭（或点击空白画布）",
    "닫기 (또는 빈 캔버스 클릭)",
    "閉じる（または空のキャンバスをクリック）",
    "إغلاق (أو انقر على اللوحة الفارغة)",
    "Chiudi (o clicca sul canvas vuoto)"
  ],
  [
    "Close page",
    "关闭页面",
    "페이지 닫기",
    "ページを閉じる",
    "إغلاق الصفحة",
    "Chiudi pagina"
  ],
  [
    "Close project",
    "关闭项目",
    "프로젝트 닫기",
    "プロジェクトを閉じる",
    "إغلاق المشروع",
    "Chiudi progetto"
  ],
  [
    "Close tab",
    "关闭标签页",
    "탭 닫기",
    "タブを閉じる",
    "إغلاق التبويب",
    "Chiudi scheda"
  ],
  [
    "Close the second-agent pane",
    "关闭第二个代理面板",
    "두 번째 에이전트 창 닫기",
    "セカンドエージェントのペインを閉じる",
    "إغلاق لوحة الوكيل الثاني",
    "Chiudi il pannello del secondo agente"
  ],
  [
    "Close this page",
    "关闭此页面",
    "이 페이지 닫기",
    "このページを閉じる",
    "إغلاق هذه الصفحة",
    "Chiudi questa pagina"
  ],
  [
    "Close this page (its worktree is removed)",
    "关闭此页面（其工作树已被移除）",
    "이 페이지 닫기 (작업 트리 제거됨)",
    "このページを閉じる（作業ツリーは削除されます）",
    "إغلاق هذه الصفحة (تمت إزالة شجرة العمل الخاصة بها)",
    "Chiudi questa pagina (il suo worktree viene rimosso)"
  ],
  [
    "Close this page? Its private worktree ({0}) and any unmerged changes are removed. Merge first to keep them.",
    "关闭此页面？它的私有工作树 ({0}) 及任何未合并的更改将被移除。先合并以保留它们。",
    "이 페이지를 닫으시겠습니까? 개인 작업 트리({0})와 병합되지 않은 변경 사항이 삭제됩니다. 이를 유지하려면 먼저 병합하세요.",
    "このページを閉じますか？これはプライベート作業ツリー（{0}）で、マージされていない変更はすべて削除されます。保持するには先にマージしてください。",
    "إغلاق هذه الصفحة؟ سيتم إزالة شجرة العمل الخاصة بها ({0}) وأي تغييرات غير مدموجة. دمج أولاً للاحتفاظ بها.",
    "Chiudi questa pagina? Il suo worktree privato ({0}) e qualsiasi modifica non unita verranno rimossi. Fai il merge prima per mantenerli."
  ],
  [
    "Close this panel (the browser keeps running for the agents)",
    "关闭此面板（浏览器将继续为代理运行）",
    "이 패널 닫기 (브라우저는 에이전트를 위해 계속 실행됨)",
    "このパネルを閉じますか（ブラウザはエージェントのために実行を続けます）",
    "إغلاق هذه اللوحة (المتصفح يستمر في العمل للوكلاء)",
    "Chiudi questo pannello (il browser continuerà a funzionare per gli agenti)"
  ],
  [
    "Close this project? Unmerged changes in its worktree ({0}) will be discarded. Merge to main first to keep them.",
    "关闭此项目？其工作树 ({0}) 中的未合并更改将被丢弃。先合并到主分支以保留它们。",
    "이 프로젝트를 닫으시겠습니까? 작업 트리({0})의 병합되지 않은 변경 사항이 제거됩니다. 이를 유지하려면 먼저 메인에 병합하세요.",
    "このプロジェクトを閉じますか？作業ツリー（{0}）の未マージの変更は破棄されます。保持するには先にメインにマージしてください。",
    "إغلاق هذا المشروع؟ سيتم تجاهل التغييرات غير المدموجة في شجرة العمل الخاصة به ({0}). دمج إلى الرئيسي أولاً للاحتفاظ بها.",
    "Chiudi questo progetto? Le modifiche non unite nel suo worktree ({0}) saranno scartate. Fai il merge con il main prima per mantenerle."
  ],
  [
    "Close/stop the persistent browser session. Reopen later with browser_open.",
    "关闭/停止持久浏览器会话。以后可使用 browser_open 重新打开。",
    "지속적인 브라우저 세션을 닫거나 중지합니다. 나중에 browser_open으로 다시 엽니다.",
    "永続ブラウザセッションを閉じる/停止します。後で browser_open で再開します。",
    "أغلق/أوقف جلسة المتصفح المستمرة. أعد فتحها لاحقًا باستخدام browser_open.",
    "Chiudi/ferma la sessione persistente del browser. Riapri più tardi con browser_open."
  ],
  [
    "Cloud accounts in sandbox",
    "沙箱中的云账户",
    "샌드박스 내 클라우드 계정",
    "サンドボックス内のクラウドアカウント",
    "حسابات السحابة في بيئة الاختبار",
    "Account cloud in sandbox"
  ],
  [
    "CN=Your Company",
    "CN=您的公司",
    "CN=귀사",
    "CN=あなたの会社",
    "CN=شركةك",
    "CN=La tua azienda"
  ],
  [
    "Co-founder chat → research (competitors, OSS, real pain) → BRIEF.md → assemble a team",
    "联合创始人聊天 → 研究（竞争对手、开源软件、真实痛点）→ BRIEF.md → 组建团队",
    "공동 창업자 채팅 → 조사 (경쟁사, 오픈 소스 소프트웨어, 실제 문제) → BRIEF.md → 팀 구성",
    "共同創業者とのチャット → 調査（競合、OSS、実際の課題） → BRIEF.md → チームを組む",
    "الدردشة مع المؤسس المشارك → البحث (المنافسون، البرمجيات مفتوحة المصدر، الألم الحقيقي) → BRIEF.md → تجميع فريق",
    "Chat del co-fondatore → ricerca (concorrenti, OSS, veri problemi) → BRIEF.md → assemblare un team"
  ],
  [
    "Co-founder is thinking…",
    "联合创始人在思考…",
    "공동 창립자가 생각 중입니다…",
    "共同創設者が考えています…",
    "المؤسس المشارك يفكر...",
    "Il co-fondatore sta pensando…"
  ],
  [
    "Code page session",
    "代码页面会话",
    "코드 페이지 세션",
    "コードページセッション",
    "جلسة صفحة الشفرات",
    "Sessione della pagina di codice"
  ],
  [
    "Code review",
    "代码审查",
    "코드 검토",
    "コードレビュー",
    "مراجعة الشيفرة",
    "Revisione del codice"
  ],
  [
    "Code signing (Windows)",
    "代码签名（Windows）",
    "코드 서명(Windows)",
    "コード署名（Windows）",
    "توقيع الشيفرة (ويندوز)",
    "Firma del codice (Windows)"
  ],
  [
    "code-signs",
    "代码签名",
    "코드 서명",
    "コード署名",
    "توقيعات الشيفرة",
    "code-signs"
  ],
  [
    "Coder",
    "程序员",
    "코더",
    "コーダー",
    "مبرمج",
    "Programmatore"
  ],
  [
    "Coding Agent",
    "编码代理",
    "코딩 에이전트",
    "コーディングエージェント",
    "وكيل الترميز",
    "Agente di codifica"
  ],
  [
    "Coding in {0}",
    "在 {0} 中编码",
    "{0}에서 코딩",
    "{0}でコーディング",
    "الترميز في {0}",
    "Codifica in {0}"
  ],
  [
    "Command is required.",
    "需要命令。",
    "명령이 필요합니다.",
    "コマンドが必要です。",
    "الأمر مطلوب.",
    "Il comando è richiesto."
  ],
  [
    "Command Loft",
    "命令阁楼",
    "명령 로프트",
    "コマンドロフト",
    "Loft الأمر",
    "Command Loft"
  ],
  [
    "Command-R",
    "命令-R",
    "Command-R",
    "コマンド-R",
    "Command-R",
    "Comando-R"
  ],
  [
    "command, paste it into",
    "命令，粘贴到",
    "명령, 여기에 붙여넣기",
    "コマンドを、に貼り付けます",
    "الأمر، الصقه في",
    "comando, incollalo in"
  ],
  [
    "Command:",
    "命令：",
    "명령:",
    "コマンド:",
    "الأمر:",
    "Comando:"
  ],
  [
    "Commit",
    "提交",
    "커밋",
    "コミット",
    "التثبيت",
    "Conferma"
  ],
  [
    "Commit {0} change(s) in this workspace",
    "在此工作区提交 {0} 个更改",
    "이 작업 공간에서 {0}개의 변경 사항 커밋",
    "このワークスペースで{0}件の変更をコミット",
    "تثبيت {0} تغيير(ات) في هذه المساحة العمل",
    "Conferma {0} modifica/e in questo spazio di lavoro"
  ],
  [
    "Commit all",
    "提交全部",
    "모두 커밋",
    "すべてコミット",
    "تثبيت الكل",
    "Conferma tutto"
  ],
  [
    "Commit all changes in this workspace",
    "提交此工作区的所有更改",
    "이 작업 공간의 모든 변경 사항 커밋",
    "このワークスペースのすべての変更をコミット",
    "تثبيت كل التغييرات في هذه المساحة العمل",
    "Conferma tutte le modifiche in questo spazio di lavoro"
  ],
  [
    "Commit message…",
    "提交信息…",
    "커밋 메시지…",
    "コミットメッセージ…",
    "رسالة الالتزام…",
    "Messaggio di commit…"
  ],
  [
    "Community-curated long tail — 200+ servers across every imaginable category.",
    "社区策划的长尾——覆盖每个 imaginable 类别的 200 多个服务器。",
    "커뮤니티 큐레이션 롱테일 — 상상할 수 있는 모든 카테고리에 걸쳐 200개 이상의 서버.",
    "コミュニティがキュレーションしたロングテール — 想像できるあらゆるカテゴリにわたる200以上のサーバー。",
    "مجموعة طويلة من المجتمع — أكثر من 200 خادم عبر كل فئة يمكن تخيلها.",
    "Community curata dalla comunità a lungo termine — oltre 200 server in ogni categoria immaginabile."
  ],
  [
    "Complete",
    "完成",
    "완료",
    "完了",
    "مكتمل",
    "Completa"
  ],
  [
    "complete ·",
    "完整 ·",
    "완료 ·",
    "完了 ·",
    "اكتمال ·",
    "completo ·"
  ],
  [
    "Complete every field above (certificate, both passwords, identity, Apple ID, Team ID) to enable pushing.",
    "完成上面的每个字段（证书、两个密码、身份、Apple ID、团队ID）以启用推送。",
    "푸시를 활성화하려면 위의 모든 필드(인증서, 두 개의 비밀번호, 신원, Apple ID, 팀 ID)를 완료하세요.",
    "上記のすべての項目（証明書、両方のパスワード、身分、Apple ID、チームID）を完了して、プッシュを有効にします。",
    "أكمل كل الحقول أعلاه (الشهادة، كليتا كلمتي المرور، الهوية، معرف Apple، معرف الفريق) لتمكين الدفع.",
    "Completa tutti i campi sopra (certificato, entrambe le password, identità, ID Apple, ID Team) per abilitare il push."
  ],
  [
    "Completed",
    "已完成",
    "완료됨",
    "完了しました",
    "مكتمل",
    "Completato"
  ],
  [
    "Completed (",
    "已完成 (",
    "완료됨 (",
    "完了（",
    "مكتمل (",
    "Completato ("
  ],
  [
    "Config:",
    "配置:",
    "구성:",
    "設定:",
    "تكوين:",
    "Config:"
  ],
  [
    "Configuration notices from the team normalizer",
    "来自团队规范器的配置通知",
    "팀 노멀라이저의 구성 공지사항",
    "チームノーマライザからの設定通知",
    "إشعارات التكوين من موحد الفريق",
    "Avvisi di configurazione dal team normalizzatore"
  ],
  [
    "Configure everything yourself",
    "自己配置所有内容",
    "모든 것을 직접 구성하세요",
    "すべて自分で設定する",
    "قم بتكوين كل شيء بنفسك",
    "Configura tutto da solo"
  ],
  [
    "configure or program another machine — a server, Raspberry Pi, or another PC.",
    "配置或编程另一台机器——服务器、Raspberry Pi 或另一台电脑。",
    "다른 기기 구성 또는 프로그래밍 — 서버, 라즈베리 파이, 또는 다른 PC.",
    "別のマシンを設定またはプログラムする — サーバー、Raspberry Pi、または別のPC。",
    "تكوين أو برمجة جهاز آخر — خادم، Raspberry Pi، أو حاسوب آخر.",
    "configura o programma un altro dispositivo — un server, Raspberry Pi o un altro PC."
  ],
  [
    "configured",
    "已配置",
    "구성됨",
    "設定済み",
    "تم التكوين",
    "configurato"
  ],
  [
    "Connect",
    "连接",
    "연결",
    "接続",
    "اتصل",
    "Connetti"
  ],
  [
    "Connect →",
    "连接 →",
    "연결 →",
    "接続 →",
    "اتصل →",
    "Connetti →"
  ],
  [
    "Connect GitHub →",
    "连接 GitHub →",
    "GitHub 연결 →",
    "GitHubに接続 →",
    "اتصل بـ GitHub →",
    "Connetti GitHub →"
  ],
  [
    "Connect GitHub above first.",
    "首先连接上面的 GitHub。",
    "먼저 GitHub를 위에서 연결하세요.",
    "まず上で GitHub に接続してください。",
    "اتصل بـ GitHub أعلاه أولاً.",
    "Connetti prima GitHub sopra."
  ],
  [
    "Connect GitHub to clone private repos, push from the sandbox — and have a repo",
    "将 GitHub 连接以克隆私有仓库，从沙箱推送 —— 并拥有一个仓库",
    "GitHub를 연결하여 개인 저장소를 클론하고, 샌드박스에서 푸시하며 — 저장소를 가지세요",
    "GitHubを接続して、プライベートリポジトリをクローンしたり、サンドボックスからプッシュしたり — そしてリポジトリを持つ",
    "اتصل بـ GitHub لاستنساخ المستودعات الخاصة، والدفع من منطقة الاختبار — ولإنشاء مستودع",
    "Connetti GitHub per clonare repository privati, fare push dal sandbox — e avere un repository"
  ],
  [
    "Connect GitHub to send",
    "连接 GitHub 以发送",
    "GitHub 연결하여 전송",
    "送信するためにGitHubと接続",
    "اتصل بـ GitHub للإرسال",
    "Connetti GitHub per inviare"
  ],
  [
    "Connect GitHub…",
    "连接 GitHub…",
    "GitHub 연결…",
    "GitHubに接続…",
    "اتصل بـ GitHub…",
    "Connetti GitHub…"
  ],
  [
    "connected",
    "已连接",
    "연결됨",
    "接続済み",
    "متصل",
    "connesso"
  ],
  [
    "Connection",
    "连接",
    "연결",
    "接続",
    "الاتصال",
    "Connessione"
  ],
  [
    "connections",
    "连接",
    "연결",
    "接続（大文字）",
    "الاتصالات",
    "CONNESSIONI"
  ],
  [
    "CONNECTIONS",
    "连接",
    "연결",
    "接続",
    "الاتصالات",
    "CONNESSIONI"
  ],
  [
    "Consented hosts — agents may INJECT (type/keys/mouse/power/mount) only into devices listed here. Screenshots work for any reachable device. Every action lands in a redacted audit log (kvm_audit.jsonl).",
    "授权主机 — 代理可能仅向此处列出的设备注入（类型/密钥/鼠标/电源/挂载）。截图适用于任何可访问的设备。每个操作都会记录在经过编辑的审计日志中（kvm_audit.jsonl）。",
    "동의된 호스트 — 에이전트는 여기에 나열된 장치에만 (타이프/키/마우스/전원/마운트)를 주입할 수 있습니다. 스크린샷은 도달 가능한 모든 장치에 대해 작동합니다. 모든 작업은 검열된 감사 로그(kvm_audit.jsonl)에 기록됩니다.",
    "同意されたホスト — エージェントはここにリストされたデバイスにのみ (タイプ／キー／マウス／電源／マウント) を注入可能です。スクリーンショットは到達可能な任意のデバイスで機能します。すべてのアクションは秘匿された監査ログ (kvm_audit.jsonl) に記録されます。",
    "المضيفون الذين تم منحهم الموافقة — يمكن للوكلاء حقن (نوع/مفاتيح/ماوس/طاقة/تركيب) فقط في الأجهزة المدرجة هنا. لقطات الشاشة تعمل لأي جهاز يمكن الوصول إليه. كل إجراء يُسجل في سجل تدقيق محجوب (kvm_audit.jsonl).",
    "Host consentiti — gli agenti possono INIETTARE (tipo/tasti/mouse/potenza/montaggio) solo nei dispositivi elencati qui. Gli screenshot funzionano per qualsiasi dispositivo raggiungibile. Ogni azione viene registrata in un registro di controllo redatto (kvm_audit.jsonl)."
  ],
  [
    "Consult that FIRST before re-deriving a fact, asking the user, or searching the",
    "在重新推导事实、询问用户或搜索之前，请先咨询它",
    "사실을 재확인하거나 사용자에게 묻거나 검색하기 전에 먼저 이를 참조하세요",
    "事実を再導出したり、ユーザーに質問したり、検索したりする前に、まずそれを確認してください",
    "استشر ذلك أولاً قبل إعادة استنباط أي حقيقة أو سؤال المستخدم أو البحث في",
    "Consulta quello PRIMA di derivare nuovamente un fatto, chiedere all'utente o cercare"
  ],
  [
    "content. Use for surgical edits — preserves the rest of the file.",
    "内容。用于外科编辑——保留文件的其余部分。",
    "콘텐츠. 수술 편집용으로 사용 — 파일의 나머지는 그대로 유지합니다.",
    "コンテンツ。外科的な編集に使用 — ファイルの残りの部分を保持します。",
    "المحتوى. استخدم للتحريرات الجراحية — يحافظ على باقي الملف.",
    "contenuto. Usalo per modifiche chirurgiche — preserva il resto del file."
  ],
  [
    "Context for the team",
    "团队的上下文",
    "팀의 컨텍스트",
    "チームのためのコンテキスト",
    "السياق للفريق",
    "Contesto per il team"
  ],
  [
    "Context window:",
    "上下文窗口：",
    "컨텍스트 창:",
    "コンテキストウィンドウ：",
    "نافذة السياق:",
    "Finestra del contesto:"
  ],
  [
    "Continue →",
    "继续 →",
    "계속 →",
    "続行 →",
    "تابع →",
    "Continua →"
  ],
  [
    "Continue the interrupted download from where it stopped (no re-pick, no restart from 0%)",
    "从中断的下载处继续（不重新选择，不从0%重新开始）",
    "중단된 다운로드를 중단된 지점에서 계속 진행 (다시 선택 금지, 0%에서 재시작 금지)",
    "中断されたダウンロードを中断した場所から続行する（再選択せず、0%から再開しない）",
    "استئناف التنزيل المتوقف من المكان الذي توقف عنده (بدون اختيار جديد، بدون إعادة بدء من 0%)",
    "Continua il download interrotto da dove si è fermato (nessuna nuova scelta, nessun riavvio da 0%)"
  ],
  [
    "Continue with this folder — pick the team on the next step",
    "继续使用此文件夹——在下一步选择团队",
    "이 폴더로 계속 — 다음 단계에서 팀을 선택하세요",
    "このフォルダで続行 — 次のステップでチームを選択してください",
    "تابع مع هذا المجلد — اختر الفريق في الخطوة التالية",
    "Continua con questa cartella — scegli il team al passo successivo"
  ],
  [
    "Continue without installing",
    "继续而不安装",
    "설치하지 않고 계속",
    "インストールせずに続行",
    "استمر دون تثبيت",
    "Continua senza installare"
  ],
  [
    "Control a networked KVM node (Sipeed NanoKVM) as the target machine's eyes + hands.",
    "控制网络KVM节点（Sipeed NanoKVM）作为目标机器的眼睛和手。",
    "네트워크 연결 KVM 노드(Sipeed NanoKVM)를 대상 기계의 눈과 손처럼 제어",
    "ネットワーク接続されたKVMノード（Sipeed NanoKVM）をターゲットマシンの目と手として制御する。",
    "تحكم في عقدة KVM متصلة بالشبكة (Sipeed NanoKVM) باعتبارها عيون وأيدي الحاسوب الهدف.",
    "Controlla un nodo KVM in rete (Sipeed NanoKVM) come occhi + mani della macchina target."
  ],
  [
    "Control your other OwLLM machines. Pairing + a cryptographic device key are required — a GitHub login alone never grants control.",
    "控制你的其他 OwLLM 设备。需要配对和加密设备密钥——仅凭 GitHub 登录永远不能获得控制权限。",
    "다른 OwLLM 기기를 제어하세요. 페어링 + 암호화 장치 키가 필요합니다 — GitHub 로그인만으로는 제어할 수 없습니다.",
    "他のOwLLMマシンを制御します。ペアリングと暗号デバイスキーが必要です — GitHubのログインだけでは制御できません。",
    "تحكم في أجهزتك الأخرى من OwLLM. يتطلب الإقران + مفتاح جهاز تشفير — تسجيل دخول GitHub وحده لا يمنح السيطرة.",
    "Controlla le tue altre macchine OwLLM. Sono necessari l'abbinamento + una chiave del dispositivo crittografico — un login su GitHub da solo non concede mai il controllo."
  ],
  [
    "Controlling a device works across",
    "设备控制适用于",
    "장치 제어는 다음에서도 작동합니다",
    "デバイスの制御は以下にわたって機能する",
    "التحكم في جهاز يعمل عبر",
    "Il controllo di un dispositivo funziona attraverso"
  ],
  [
    "Convert failed: {0}",
    "转换失败：{0}",
    "변환 실패: {0}",
    "変換に失敗しました: {0}",
    "فشل التحويل: {0}",
    "Conversione fallita: {0}"
  ],
  [
    "Converted — opened {0}.",
    "已转换 — 已打开 {0}。",
    "변환됨 — {0} 열림.",
    "変換済み — {0} を開きました。",
    "تم التحويل — تم فتح {0}.",
    "Convertito — aperto {0}."
  ],
  [
    "Copied",
    "已复制",
    "복사됨",
    "コピー済み",
    "تم النسخ",
    "Copiato"
  ],
  [
    "copied your code",
    "已复制你的代码",
    "코드를 복사했습니다",
    "コードをコピーしました",
    "تم نسخ الكود الخاص بك",
    "Hai copiato il tuo codice"
  ],
  [
    "Copy",
    "复制",
    "복사",
    "コピー",
    "نسخ",
    "Copia"
  ],
  [
    "Copy a LOCAL file to a REMOTE host over SSH/SCP using the user's SSH keys.",
    "使用用户的 SSH 密钥通过 SSH/SCP 将本地文件复制到远程主机。",
    "사용자의 SSH 키를 사용하여 로컬 파일을 원격 호스트로 SSH/SCP를 통해 복사합니다.",
    "SSH/SCPを使用して、ユーザーのSSHキーでローカルファイルをリモートホストにコピーします。",
    "نسخ ملف محلي إلى مضيف بعيد عبر SSH/SCP باستخدام مفاتيح SSH الخاصة بالمستخدم.",
    "Copia un file LOCALE su un host REMOTO tramite SSH/SCP usando le chiavi SSH dell'utente."
  ],
  [
    "Copy a REMOTE file to the LOCAL machine over SSH/SCP using the user's SSH keys.",
    "使用用户的 SSH 密钥通过 SSH/SCP 将远程文件复制到本地机器。",
    "사용자의 SSH 키를 사용하여 원격 파일을 로컬 기계로 SSH/SCP를 통해 복사합니다.",
    "SSH/SCPを使用して、ユーザーのSSHキーでリモートファイルをローカルマシンにコピーします。",
    "نسخ ملف بعيد إلى الجهاز المحلي عبر SSH/SCP باستخدام مفاتيح SSH الخاصة بالمستخدم.",
    "Copia un file REMOTO sulla macchina LOCALE tramite SSH/SCP usando le chiavi SSH dell'utente."
  ],
  [
    "Copy into workspace",
    "复制到工作区",
    "작업공간으로 복사",
    "ワークスペースにコピー",
    "نسخ إلى مساحة العمل",
    "Copia nella workspace"
  ],
  [
    "Copy key",
    "复制密钥",
    "키 복사",
    "キーをコピー",
    "نسخ المفتاح",
    "Copia chiave"
  ],
  [
    "Copy LAN URL to clipboard",
    "将局域网 URL 复制到剪贴板",
    "LAN URL을 클립보드에 복사",
    "LANのURLをクリップボードにコピー",
    "نسخ رابط LAN إلى الحافظة",
    "Copia URL LAN negli appunti"
  ],
  [
    "Copy path",
    "复制路径",
    "경로 복사",
    "パスをコピー",
    "نسخ المسار",
    "Copia percorso"
  ],
  [
    "Copy PEM",
    "复制 PEM",
    "PEM 복사",
    "PEMをコピー",
    "نسخ PEM",
    "Copia PEM"
  ],
  [
    "Copy the code",
    "复制代码",
    "코드 복사",
    "コードをコピー",
    "نسخ الكود",
    "Copia il codice"
  ],
  [
    "Copy the file into the project folder (recommended)",
    "将文件复制到项目文件夹（推荐）",
    "파일을 프로젝트 폴더에 복사 (권장)",
    "ファイルをプロジェクトフォルダにコピー（推奨）",
    "نسخ الملف إلى مجلد المشروع (موصى به)",
    "Copia il file nella cartella del progetto (consigliato)"
  ],
  [
    "Copy the model identifier to the clipboard.",
    "将模型标识符复制到剪贴板。",
    "모델 식별자를 클립보드에 복사",
    "モデル識別子をクリップボードにコピー",
    "نسخ معرف النموذج إلى الحافظة.",
    "Copia l'identificatore del modello negli appunti."
  ],
  [
    "Copy the OpenAI-compatible base URL to the clipboard.",
    "将兼容 OpenAI 的基础 URL 复制到剪贴板。",
    "OpenAI 호환 기본 URL을 클립보드에 복사",
    "OpenAI互換のベースURLをクリップボードにコピー",
    "نسخ عنوان URL الأساسي المتوافق مع OpenAI إلى الحافظة.",
    "Copia l'URL base compatibile con OpenAI negli appunti."
  ],
  [
    "Copy this isolated project OUT to a normal folder (NOT isolated) and open the copy? The isolated original stays in the sandbox.",
    "将此隔离项目复制到普通文件夹（非隔离）并打开副本？隔离的原件仍保留在沙箱中。",
    "이 격리된 프로젝트를 일반 폴더(격리되지 않음)로 복사하고 복사본을 열겠습니까? 원래 격리된 폴더는 샌드박스에 남습니다.",
    "この孤立したプロジェクトを通常のフォルダー（孤立していない）にコピーしてコピーを開きますか？孤立した元はサンドボックスに残ります。",
    "نسخ هذا المشروع المعزول إلى مجلد عادي (غير معزول) وفتح النسخة؟ يبقى الأصل المعزول في الصندوق.",
    "Copia questo progetto isolato FUORI in una cartella normale (NON isolata) e apri la copia? L'originale isolato resta nella sandbox."
  ],
  [
    "Copy this project INTO the Linux sandbox (isolated) and open it",
    "将此项目复制到 Linux 沙箱（隔离）并打开它",
    "이 프로젝트를 리눅스 샌드박스(격리)로 복사하고 엽니다",
    "このプロジェクトをLinuxサンドボックス（孤立）にコピーして開きます",
    "نسخ هذا المشروع إلى صندوق لينكس (معزول) وفتحه",
    "Copia questo progetto DENTRO la sandbox di Linux (isolata) e aprilo"
  ],
  [
    "Copy this project INTO the Linux sandbox (isolated) and open the copy? The original folder stays where it is.",
    "将此项目复制到 Linux 沙箱（隔离）并打开副本？原始文件夹保持原位。",
    "이 프로젝트를 리눅스 샌드박스(격리)로 복사하고 복사본을 열겠습니까? 원본 폴더는 제자리에 남습니다.",
    "このプロジェクトをLinuxサンドボックス（孤立）にコピーしてコピーを開きますか？元のフォルダーはそのまま残ります。",
    "نسخ هذا المشروع إلى صندوق لينكس (معزول) وفتح النسخة؟ يبقى المجلد الأصلي حيث هو.",
    "Copia questo progetto DENTRO la sandbox di Linux (isolata) e apri la copia? La cartella originale resta dove si trova."
  ],
  [
    "Copy this project INTO the Linux sandbox and switch to the copy? The original folder stays where it is. A large repo can take a minute.",
    "将此项目复制到 Linux 沙箱并切换到副本？原始文件夹保持原位。大型仓库可能需要一分钟。",
    "이 프로젝트를 Linux 샌드박스로 복사하고 복사본으로 전환하시겠습니까? 원래 폴더는 그대로 있습니다. 대형 저장소는 1분 정도 걸릴 수 있습니다.",
    "このプロジェクトをLinuxサンドボックスにコピーしてコピーに切り替えますか？元のフォルダーはそのまま残ります。大きなリポジトリは1分ほどかかる場合があります。",
    "نسخ هذا المشروع إلى صندوق الرمل في لينكس والتبديل إلى النسخة؟ المجلد الأصلي يبقى في مكانه. يمكن أن يستغرق المستودع الكبير دقيقة.",
    "Copia questo progetto NEL sandbox Linux e passa alla copia? La cartella originale rimane dove si trova. Un repository grande può richiedere un minuto."
  ],
  [
    "Copy this project OUT to a normal (not isolated) folder and open it",
    "将此项目复制到普通（非隔离）文件夹并打开它",
    "이 프로젝트를 일반(격리되지 않은) 폴더로 복사하고 열기",
    "このプロジェクトを通常の（孤立していない）フォルダーにコピーして開きます",
    "نسخ هذا المشروع إلى مجلد عادي (ليس معزولًا) وفتحه",
    "Copia questo progetto FUORI in una cartella normale (non isolata) e aprilo"
  ],
  [
    "Copy values",
    "复制数值",
    "값 복사",
    "値をコピー",
    "نسخ القيم",
    "Copia valori"
  ],
  [
    "Copy visible log lines to clipboard.",
    "将可见日志行复制到剪贴板。",
    "보이는 로그 줄을 클립보드로 복사",
    "表示されているログ行をクリップボードにコピー",
    "نسخ الأسطر المرئية من السجل إلى الحافظة.",
    "Copia righe di log visibili negli appunti."
  ],
  [
    "Copying into the sandbox…",
    "正在复制到沙盒…",
    "샌드박스로 복사하는 중…",
    "サンドボックスにコピーしています…",
    "النسخ إلى منطقة الاختبار…",
    "Copia in corso nella sandbox…"
  ],
  [
    "Copying out of the sandbox…",
    "从沙箱中复制出…",
    "샌드박스에서 복사 중…",
    "サンドボックスからコピー中…",
    "النسخ من الصندوق الرملي…",
    "Copia dalla sandbox…"
  ],
  [
    "Copying…",
    "复制中…",
    "복사 중…",
    "コピー中…",
    "نسخ…",
    "Copia…"
  ],
  [
    "CORE",
    "核心",
    "CORE",
    "コア",
    "النواة",
    "NUCLEO"
  ],
  [
    "Core:",
    "核心：",
    "코어:",
    "コア:",
    "النواة:",
    "Nucleo:"
  ],
  [
    "cores",
    "核心",
    "코어들",
    "コアたち",
    "النوى",
    "nuclei"
  ],
  [
    "Could not bind the webhook port.",
    "无法绑定网页钩子端口。",
    "웹훅 포트를 바인딩할 수 없습니다.",
    "ウェブフックポートをバインドできませんでした。",
    "تعذر ربط منفذ الويب هوك.",
    "Impossibile collegare la porta del webhook."
  ],
  [
    "Could not load module registry",
    "无法加载模块注册表",
    "모듈 레지스트리를 불러올 수 없습니다",
    "モジュールレジストリを読み込めませんでした",
    "تعذر تحميل سجل الوحدات",
    "Impossibile caricare il registro dei moduli"
  ],
  [
    "Could not open the workbench.",
    "无法打开工作台。",
    "워크벤치를 열 수 없습니다.",
    "ワークベンチを開けませんでした。",
    "تعذر فتح منصة العمل.",
    "Impossibile aprire il banco di lavoro."
  ],
  [
    "Could not start recording.",
    "无法开始录制。",
    "녹화를 시작할 수 없습니다.",
    "記録を開始できませんでした。",
    "تعذر بدء التسجيل.",
    "Impossibile avviare la registrazione."
  ],
  [
    "Couldn't add files: {0}",
    "无法添加文件：{0}",
    "파일을 추가할 수 없었어요: {0}",
    "ファイルを追加できませんでした: {0}",
    "تعذر إضافة الملفات: {0}",
    "Impossibile aggiungere file: {0}"
  ],
  [
    "Couldn't change isolation: {0}",
    "无法更改隔离：{0}",
    "고립은 바꿀 수 없었다: {0}",
    "隔離を変更できませんでした: {0}",
    "تعذر تغيير العزل: {0}",
    "Impossibile modificare l'isolamento: {0}"
  ],
  [
    "Couldn't create project: {0}",
    "无法创建项目：{0}",
    "프로젝트를 만들 수 없었어요: {0}",
    "プロジェクトを作成できませんでした: {0}",
    "تعذر إنشاء المشروع: {0}",
    "Impossibile creare il progetto: {0}"
  ],
  [
    "Couldn't launch WSL install: {0}",
    "无法启动 WSL 安装：{0}",
    "WSL 설치를 실행할 수 없었어요: {0}",
    "WSLインストールを起動できませんでした: {0}",
    "تعذر تشغيل تثبيت WSL: {0}",
    "Impossibile avviare l'installazione di WSL: {0}"
  ],
  [
    "Couldn't load models: {0}",
    "无法加载模型：{0}",
    "모델을 불러올 수 없었어요: {0}",
    "モデルを読み込めませんでした: {0}",
    "تعذر تحميل النماذج: {0}",
    "Impossibile caricare modelli: {0}"
  ],
  [
    "Couldn't load this template from disk — refresh and try again.",
    "无法从磁盘加载此模板 — 刷新并重试。",
    "디스크에서 이 템플릿을 불러올 수 없습니다 — 새로 고친 후 다시 시도하세요.",
    "このテンプレートをディスクから読み込めませんでした — 更新してもう一度試してください。",
    "تعذر تحميل هذا القالب من القرص — قم بالتحديث وحاول مرة أخرى.",
    "Non è stato possibile caricare questo modello dal disco — aggiorna e riprova."
  ],
  [
    "Couldn't read a team from the model's reply — try again, or build the team on the canvas.",
    "无法从模型的回复中读取团队——请重试，或在画布上构建团队。",
    "모델의 응답에서 팀을 읽을 수 없습니다 — 다시 시도하거나 캔버스에서 팀을 구성해 보세요.",
    "モデルの返信からチームを読み取れませんでした — もう一度試すか、キャンバス上でチームを作成してください。",
    "لم أستطع قراءة الفريق من رد النموذج — حاول مرة أخرى، أو أنشئ الفريق على اللوحة.",
    "Impossibile leggere una squadra dalla risposta del modello — prova di nuovo, oppure crea la squadra sulla tela."
  ],
  [
    "CPU:",
    "CPU：",
    "CPU:",
    "CPU:",
    "المعالج:",
    "CPU:"
  ],
  [
    "Create a directory (and any missing parent dirs).",
    "创建目录（以及任何缺失的父目录）。",
    "디렉터리(그리고 빠진 부모 디렉터리)를 만드세요.",
    "ディレクトリを作成する（不足している親ディレクトリも作成）。",
    "إنشاء دليل (وأي أدلة رئيسية مفقودة).",
    "Crea una directory (e tutte le eventuali directory genitrici mancanti)."
  ],
  [
    "create a free account",
    "创建一个免费账户",
    "무료 계정 만들기",
    "無料アカウントを作成",
    "إنشاء حساب مجاني",
    "crea un account gratuito"
  ],
  [
    "Create a NEW file or fully rewrite an existing one. Parent dirs are",
    "创建一个新文件或完全重写现有文件。父目录是",
    "새 파일을 만들거나 기존 파일을 완전히 다시 작성하세요. 부모 디렉터리는",
    "新しいファイルを作成するか、既存のファイルを完全に書き直す。親ディレクトリは",
    "إنشاء ملف جديد أو إعادة كتابة ملف موجود بالكامل. الأدلة الرئيسية هي",
    "Crea un NUOVO file o riscrivi completamente uno esistente. Le directory genitrici sono"
  ],
  [
    "Create a new project",
    "创建一个新项目",
    "새 프로젝트 만들기",
    "新しいプロジェクトを作成",
    "إنشاء مشروع جديد",
    "Crea un nuovo progetto"
  ],
  [
    "Create a private GitHub repo",
    "创建一个私人 GitHub 仓库",
    "개인 GitHub 저장소를 만들기",
    "プライベートGitHubリポジトリを作成",
    "إنشاء مستودع GitHub خاص",
    "Crea un repository privato su GitHub"
  ],
  [
    "Create a private GitHub repository for this project, set it as origin, and push the current branch. Needs a connected GitHub account (Accounts page).",
    "为此项目创建一个私人 GitHub 仓库，将其设置为远程 origin，并推送当前分支。需要已连接的 GitHub 账户（账户页面）。",
    "이 프로젝트를 위한 개인 GitHub 저장소를 만들고, 이를 원격 저장소(origin)로 설정한 후 현재 브랜치를 푸시하세요. 연결된 GitHub 계정이 필요합니다 (계정 페이지).",
    "このプロジェクトのプライベートGitHubリポジトリを作成し、originとして設定して現在のブランチをプッシュ。GitHubアカウントが接続されている必要があります（アカウントページ）。",
    "أنشئ مستودع GitHub خاص لهذا المشروع، واضبطه كـ origin، وادفع الفرع الحالي. يتطلب حساب GitHub متصل (صفحة الحسابات).",
    "Crea un repository privato su GitHub per questo progetto, impostalo come origin e invia il branch corrente. Richiede un account GitHub connesso (pagina Account)."
  ],
  [
    "create a token",
    "创建令牌",
    "토큰 생성",
    "トークンを作成",
    "إنشاء رمز",
    "crea un token"
  ],
  [
    "Create card",
    "创建卡片",
    "카드 생성",
    "カードを作成",
    "إنشاء بطاقة",
    "Crea scheda"
  ],
  [
    "Create Dataset",
    "创建数据集",
    "데이터셋 생성",
    "データセットを作成",
    "إنشاء مجموعة بيانات",
    "Crea Dataset"
  ],
  [
    "Create failed: {0}",
    "创建失败：{0}",
    "생성 실패: {0}",
    "作成に失敗しました: {0}",
    "فشل الإنشاء: {0}",
    "Creazione fallita: {0}"
  ],
  [
    "Create isolated project",
    "创建独立项目",
    "독립 프로젝트 생성",
    "隔離されたプロジェクトを作成",
    "إنشاء مشروع معزول",
    "Crea progetto isolato"
  ],
  [
    "Create new team",
    "创建新团队",
    "새 팀 생성",
    "新しいチームを作成",
    "إنشاء فريق جديد",
    "Crea nuovo team"
  ],
  [
    "Create project",
    "创建项目",
    "프로젝트 생성",
    "プロジェクトを作成",
    "إنشاء مشروع",
    "Crea progetto"
  ],
  [
    "Create team",
    "创建团队",
    "팀 생성",
    "チームを作成",
    "إنشاء فريق",
    "Crea team"
  ],
  [
    "Create your Linux user",
    "创建你的 Linux 用户",
    "Linux 사용자 생성",
    "自分のLinuxユーザーを作成",
    "إنشاء مستخدم لينكس الخاص بك",
    "Crea il tuo utente Linux"
  ],
  [
    "Create your own team",
    "创建你自己的团队",
    "자신만의 팀 생성",
    "自分自身のチームを作成",
    "إنشاء فريقك الخاص",
    "Crea il tuo team"
  ],
  [
    "CREATE_NO_WINDOW",
    "创建无窗口",
    "창 없이 생성",
    "ウィンドウなしで作成",
    "CREATE_NO_WINDOW",
    "CREATE_NO_WINDOW"
  ],
  [
    "created automatically. Use this when writing fresh code / configs /",
    "自动创建。在编写新代码/配置时使用此选项 /",
    "자동으로 생성됨. 새 코드 / 설정을 작성할 때 사용하세요 /",
    "自動的に作成されました。新しいコードや設定を書くときにこれを使用します/",
    "تم الإنشاء تلقائيًا. استخدم هذا عند كتابة كود/إعدادات جديدة /",
    "creato automaticamente. Usa questo quando scrivi codice / configurazioni nuovi /"
  ],
  [
    "created for you",
    "已为你创建",
    "당신을 위해 생성됨",
    "あなたのために作成されました",
    "أنشئ من أجلك",
    "creato per te"
  ],
  [
    "Created inside",
    "已创建于",
    "내부에서 생성됨",
    "内部で作成されました",
    "تم إنشاؤه داخليًا",
    "Creato all'interno"
  ],
  [
    "Created:",
    "已创建：",
    "생성됨:",
    "作成されました:",
    "تم الإنشاء:",
    "Creato:"
  ],
  [
    "Creates a PRIVATE repository on your GitHub account named after the project, wires it as origin, and pushes the initial branch — nothing else to set up. You can also do this later from the Publisher card's ⚙ Set up repo.",
    "在你的 GitHub 账户上创建一个以项目命名的私人仓库，将其设置为 origin，并推送初始分支——无需其他设置。你也可以稍后在发布者卡片的 ⚙ 设置仓库 中进行此操作。",
    "프로젝트 이름으로 GitHub 계정에 PRIVATE 저장소를 생성하고, 이를 origin으로 연결한 뒤 초기 브랜치를 푸시합니다 — 다른 설정은 필요 없습니다. 나중에 Publisher 카드의 ⚙ 저장소 설정에서 이 작업을 수행할 수도 있습니다.",
    "プロジェクト名であなたのGitHubアカウントにPRIVATEリポジトリを作成し、originとして設定し、初期ブランチをプッシュします — 他に設定は必要ありません。また、後でPublisherカードの⚙ リポジトリ設定からこれを行うこともできます。",
    "ينشئ مستودعًا خاصًا على حساب GitHub الخاص بك باسم المشروع، يوصله كأصل، ويدفع الفرع الأولي — لا يوجد شيء آخر لإعداده. يمكنك أيضًا القيام بذلك لاحقًا من بطاقة الناشر ⚙ إعداد المستودع.",
    "Crea un repository PRIVATO sul tuo account GitHub con il nome del progetto, lo configura come origin e invia il branch iniziale — non c'è nient'altro da configurare. Puoi farlo anche in seguito dalla scheda Publisher cliccando su ⚙ Configura repository."
  ],
  [
    "Creating…",
    "创建中…",
    "생성 중…",
    "作成中…",
    "جارٍ الإنشاء…",
    "Creazione…"
  ],
  [
    "critic",
    "批评者",
    "비평가",
    "批評家",
    "ناقد",
    "critico"
  ],
  [
    "critic = super user (decides for me)",
    "批评者 = 超级用户（为我决定）",
    "비평가 = 슈퍼 유저 (나를 대신해 결정)",
    "批評家 = スーパー ユーザー（私のために決定する）",
    "ناقد = مستخدم مميز (يقرر عني)",
    "critico = super utente (decide per me)"
  ],
  [
    "Critical Thinker — always-present advisor (configure in Director Mode on the Agents page)",
    "批判性思考者——始终在场的顾问（在代理页面的导演模式中配置）",
    "비판적 사상가 — 항상 존재하는 조언자(에이전트 페이지의 디렉터 모드에서 구성)",
    "クリティカルシンカー — 常に存在するアドバイザー（エージェントページのディレクターモードで設定）",
    "المفكر النقدي — المستشار الدائم الحضور (قم بتكوينه في وضع المدير على صفحة الوكلاء)",
    "Pensatore Critico — consigliere sempre presente (configura in Modalità Direttore nella pagina Agenti)"
  ],
  [
    "Ctrl+Enter digests",
    "Ctrl+Enter 消化",
    "Ctrl+Enter로 요약",
    "Ctrl+Enter で要約",
    "Ctrl+Enter لتلخيص",
    "Ctrl+Invio elabora"
  ],
  [
    "ctx",
    "上下文",
    "ctx",
    "コンテキスト",
    "السياق",
    "ctx"
  ],
  [
    "current",
    "当前",
    "현재",
    "現在",
    "الحالي",
    "corrente"
  ],
  [
    "Current: {0} Click to switch to another folder",
    "当前：{0} 点击切换到其他文件夹",
    "현재: {0} 다른 폴더로 전환하려면 클릭",
    "現在: {0} 他のフォルダーに切り替えるにはクリック",
    "الحالي: {0} انقر للتبديل إلى مجلد آخر",
    "Corrente: {0} Clicca per passare a un'altra cartella"
  ],
  [
    "custom",
    "自定义",
    "사용자 정의",
    "カスタム",
    "مُخَصَّص",
    "PERSONALIZZATO"
  ],
  [
    "Custom",
    "自定义",
    "사용자 정의",
    "カスタム",
    "مخصص",
    "Personalizzato"
  ],
  [
    "CUSTOM",
    "自定义",
    "사용자 정의",
    "カスタム",
    "مخصص",
    "PERSONALIZZATO"
  ],
  [
    "Custom context size (tokens)",
    "自定义上下文大小（令牌）",
    "사용자 지정 컨텍스트 크기(토큰)",
    "カスタムコンテキストサイズ（トークン）",
    "حجم سياق مخصص (رموز)",
    "Dimensione del contesto personalizzata (token)"
  ],
  [
    "Custom roster",
    "自定义花名册",
    "사용자 지정 명단",
    "カスタム名簿",
    "قائمة مخصصة",
    "Elenco personalizzato"
  ],
  [
    "Custom: {0}",
    "自定义：{0}",
    "사용자 지정: {0}",
    "カスタム: {0}",
    "مخصص: {0}",
    "Personalizzato: {0}"
  ],
  [
    "Custom…",
    "自定义…",
    "맞춤…",
    "カスタム…",
    "تخصيص…",
    "Personalizzato…"
  ],
  [
    "Danger zone",
    "危险区域",
    "위험 지역",
    "危険ゾーン",
    "منطقة الخطر",
    "Zona pericolosa"
  ],
  [
    "Dangerous action needs your approval",
    "危险操作需要您的批准",
    "위험한 작업, 승인이 필요합니다",
    "危険な操作にはあなたの承認が必要です",
    "إجراء خطير يحتاج إلى موافقتك",
    "Azione pericolosa richiede la tua approvazione"
  ],
  [
    "dark",
    "暗",
    "어두운",
    "ダーク",
    "داكن",
    "Scuro"
  ],
  [
    "Dark",
    "黑暗",
    "어두운",
    "ダーク",
    "داكن",
    "Scuro"
  ],
  [
    "Data analysis",
    "数据分析",
    "데이터 분석",
    "データ分析",
    "تحليل البيانات",
    "Analisi dei dati"
  ],
  [
    "Dataset Builder",
    "数据集构建器",
    "데이터셋 빌더",
    "データセットビルダー",
    "منشئ مجموعة البيانات",
    "Costruttore di dataset"
  ],
  [
    "Dataset Builder log",
    "数据集构建器日志",
    "데이터셋 빌더 로그",
    "データセットビルダーのログ",
    "سجل منشئ مجموعة البيانات",
    "Registro del Costruttore di dataset"
  ],
  [
    "Dataset can't train as-is — {0}",
    "数据集无法按原样训练 — {0}",
    "데이터셋을 있는 그대로 학습할 수 없습니다 — {0}",
    "データセットはそのままでは訓練できません — {0}",
    "لا يمكن تدريب مجموعة البيانات كما هي — {0}",
    "Il set di dati non può essere addestrato così com'è — {0}"
  ],
  [
    "Dataset check failed: {0}",
    "数据集检查失败：{0}",
    "데이터셋 확인 실패: {0}",
    "データセットのチェックに失敗しました: {0}",
    "فحص مجموعة البيانات فشل: {0}",
    "Controllo del dataset fallito: {0}"
  ],
  [
    "Dataset has 0 examples — nothing to train on.",
    "数据集有0个示例 — 没有可训练的内容。",
    "데이터셋에 예제가 0개입니다 — 학습할 것이 없습니다.",
    "データセットには例が0件です — 訓練するものがありません。",
    "مجموعة البيانات تحتوي على 0 مثال — لا يوجد شيء للتدريب عليه.",
    "Il set di dati ha 0 esempi — nulla su cui addestrare."
  ],
  [
    "Debug Office",
    "调试办公室",
    "디버그 오피스",
    "デバッグオフィス",
    "مكتب التصحيح",
    "Ufficio di debug"
  ],
  [
    "dedicated mailbox",
    "专用邮箱",
    "전용 메일함",
    "専用メールボックス",
    "صندوق بريد مخصص",
    "casella di posta dedicata"
  ],
  [
    "DeepSeek",
    "DEEPSEEK",
    "DEEPSEEK",
    "DEEPSEEK",
    "DEEPSEEK",
    "DEEPSEEK"
  ],
  [
    "DEEPSEEK",
    "深度搜索",
    "디프식",
    "DEEPSEEK",
    "ديبسيك",
    "DEEPSEEK"
  ],
  [
    "DeepSeek R1 / V3",
    "DeepSeek R1 / V3",
    "DeepSeek R1 / V3",
    "DeepSeek R1 / V3",
    "DeepSeek R1 / V3",
    "DeepSeek R1 / V3"
  ],
  [
    "Default is read-only diagnostics. File writes & admin also require a per-action approval on this machine (not executable in v1).",
    "默认是只读诊断。文件写入和管理员操作也需要在此机器上每次操作都获得批准（在 v1 中不可执行）。",
    "기본값은 읽기 전용 진단입니다. 파일 쓰기 및 관리 작업도 이 컴퓨터에서 작업별 승인이 필요합니다(버전 1에서는 실행 불가).",
    "デフォルトは読み取り専用の診断です。ファイルの書き込みや管理者権限も、このマシンではアクションごとの承認が必要です（v1では実行できません）。",
    "الإعداد الافتراضي هو التشخيص للقراءة فقط. الكتابة إلى الملفات والمهام الإدارية تتطلب أيضًا موافقة لكل إجراء على هذا الجهاز (غير قابل للتنفيذ في الإصدار 1).",
    "Predefinito è solo diagnostica in lettura. Scritture su file e accesso amministrativo richiedono anche un'approvazione per ogni azione su questa macchina (non eseguibile in v1)."
  ],
  [
    "Default mode",
    "默认模式",
    "기본 모드",
    "デフォルトモード",
    "الوضع الافتراضي",
    "Modalità predefinita"
  ],
  [
    "Default model",
    "默认模型",
    "기본 모델",
    "デフォルトモデル",
    "النموذج الافتراضي",
    "Modello predefinito"
  ],
  [
    "default to http) — use it to check a web app you are building.",
    "默认为 http）— 使用它来检查你正在构建的网络应用程序。",
    "기본값은 http) — 이를 사용하여 구축 중인 웹 앱을 확인하세요.",
    "デフォルトは http) — これを使って、あなたが作っているウェブアプリを確認します。",
    "افتراضي إلى http) — استخدمه لفحص تطبيق ويب تقوم ببنائه.",
    "impostazione predefinita su http) — usalo per controllare un'app web che stai costruendo."
  ],
  [
    "Definition of Done",
    "完成定义",
    "완료 정의",
    "完了の定義",
    "تعريف الإنجاز",
    "Definizione di completamento"
  ],
  [
    "Del",
    "删除",
    "삭제",
    "削除",
    "حذف",
    "Del"
  ],
  [
    "delete",
    "删除",
    "삭제",
    "削除",
    "حذف",
    "Elimina"
  ],
  [
    "Delete",
    "删除",
    "삭제",
    "削除",
    "حذف",
    "Elimina"
  ],
  [
    "Delete {0} cache/trash entr{1}",
    "删除 {0} 缓存/垃圾条目{1}",
    "{0} 캐시/휴지통 항목 {1} 삭제",
    "キャッシュ/ゴミ箱のエントリ {1} を {0} 削除",
    "حذف {0} ذاكرة التخزين المؤقت/سلة المهملات {1}",
    "Elimina {0} cache/spazzatura entr{1}"
  ],
  [
    "Delete asset?",
    "删除资源？",
    "자산을 삭제하시겠습니까?",
    "アセットを削除しますか？",
    "حذف الأصل؟",
    "Eliminare l'asset?"
  ],
  [
    "Delete custom agent '{0}'? Teams referencing it keep working off their own copies.",
    "删除自定义代理 '{0}'？引用它的团队将继续使用他们自己的副本。",
    "사용자 지정 에이전트 '{0}'를 삭제하시겠습니까? 이를 참조하는 팀은 각자의 복사본을 계속 사용합니다.",
    "カスタムエージェント '{0}' を削除しますか？ 参照しているチームは自分自身のコピーで引き続き動作します。",
    "حذف الوكيل المخصص '{0}'؟ الفرق التي تشير إليه ستستمر في العمل من نسخها الخاصة.",
    "Eliminare l'agente personalizzato '{0}'? I team che lo stanno utilizzando continueranno a lavorare sulle loro copie."
  ],
  [
    "Delete failed: {0}",
    "删除失败：{0}",
    "삭제 실패: {0}",
    "削除に失敗しました: {0}",
    "فشل الحذف: {0}",
    "Eliminazione fallita: {0}"
  ],
  [
    "Delete permanently",
    "永久删除",
    "영구적으로 삭제",
    "永久削除",
    "الحذف بشكل دائم",
    "Elimina permanentemente"
  ],
  [
    "Delete step",
    "删除步骤",
    "삭제 단계",
    "削除ステップ",
    "خطوة الحذف",
    "Elimina passo"
  ],
  [
    "Delete the saved login for {0} ({1})?",
    "删除 {0} ({1}) 的已保存登录信息？",
    "{0} ({1})의 저장된 로그인 정보를 삭제하시겠습니까?",
    "{0}({1})の保存したログインを削除すべきですか?",
    "حذف تسجيل الدخول المحفوظ لـ {0} ({1})؟",
    "Eliminare il login salvato per {0} ({1})?"
  ],
  [
    "Delete the source to reclaim disk? The abliterated copy stays.",
    "删除源以释放磁盘空间？已消除的副本将保留。",
    "디스크를 회수하기 위해 소스를 삭제하시겠습니까? 축약된 복사본은 남아 있습니다.",
    "ディスクを回収するためにソースを削除すべきですか?削除されたコピーはそのまま残ります。",
    "حذف المصدر لاسترجاع مساحة القرص؟ النسخة المدمرة تبقى.",
    "Eliminare la fonte per liberare spazio su disco? La copia abbrutita rimane."
  ],
  [
    "Delete the team template '{0}'? Existing projects spawned from it stay intact.",
    "删除团队模板 '{0}'？由其生成的现有项目将保持完整。",
    "팀 템플릿 '{0}'를 삭제하시겠습니까? 이를 기반으로 생성된 기존 프로젝트는 그대로 유지됩니다.",
    "チームテンプレート「{0}」を削除すべきですか?そこから生まれた既存のプロジェクトはそのまま残ります。",
    "حذف قالب الفريق '{0}'؟ المشاريع الحالية المستنسخة منه تبقى سليمة.",
    "Eliminare il modello di team '{0}'? I progetti esistenti derivati da esso restano intatti."
  ],
  [
    "Delete this memory",
    "删除此记忆",
    "이 메모리를 삭제",
    "この記憶を削除してください",
    "حذف هذه الذاكرة",
    "Elimina questa memoria"
  ],
  [
    "Delete this weight file",
    "删除此权重文件",
    "이 가중치 파일을 삭제",
    "このウェイトファイルを削除してください",
    "حذف ملف الوزن هذا",
    "Elimina questo file di peso"
  ],
  [
    "Delete tuned model \"{0}\"? Path: {1} This is permanent — the directory and all its files will be removed.",
    "删除微调模型 \"{0}\"？路径: {1} 这是永久操作——该目录及其所有文件将被删除。",
    "\"{0}\" 튜닝된 모델을 삭제하시겠습니까? 경로: {1} 이것은 영구적입니다 — 해당 디렉토리와 모든 파일이 제거됩니다.",
    "\"{0}\"というチューニング済みモデルを削除しますか？ パス: {1} これは永久です — ディレクトリとそのすべてのファイルが削除されます。",
    "حذف النموذج المضبوط \"{0}\"؟ المسار: {1} هذا دائم — سيتم حذف الدليل وجميع ملفاته.",
    "Eliminare il modello ottimizzato \"{0}\"? Percorso: {1} Questo è permanente — la directory e tutti i suoi file saranno rimossi."
  ],
  [
    "Deleting cache/trash",
    "正在删除缓存/垃圾",
    "캐시/휴지통 삭제 중",
    "キャッシュ/ゴミ箱の削除",
    "حذف ذاكرة التخزين المؤقت/المهملات",
    "Eliminazione cache/cestino"
  ],
  [
    "Deleting...",
    "正在删除...",
    "삭제 중...",
    "削除中...",
    "جارٍ الحذف...",
    "Eliminazione..."
  ],
  [
    "Deleting…",
    "正在删除…",
    "삭제 중…",
    "削除中…",
    "جارٍ الحذف…",
    "Eliminazione in corso…"
  ],
  [
    "Deny",
    "拒绝",
    "거부",
    "否定",
    "رفض",
    "Rifiuta"
  ],
  [
    "depends on:",
    "依赖于：",
    "다음에 따라 다름:",
    "状況によります:",
    "يعتمد على:",
    "dipende da:"
  ],
  [
    "Derived as 2 × r (PEFT convention). Effective scaling = α / r.",
    "根据 2 × r（PEFT 约定）派生。有效缩放 = α / r。",
    "2 × r (PEFT 규칙)로 파생됨. 유효 스케일링 = α / r.",
    "2 × rとして導出（PEFTの慣例）。実効スケーリング = α / r。",
    "مشتق كـ 2 × r (اتفاقية PEFT). التحجيم الفعلي = α / r.",
    "Derivato come 2 × r (convenzione PEFT). Scalatura efficace = α / r."
  ],
  [
    "Describe the bug",
    "描述错误",
    "버그 설명",
    "バグを説明してください",
    "وصف الخطأ",
    "Descrivi il bug"
  ],
  [
    "Describe the change, bug, or feature… (paste/drop images too)",
    "描述更改、错误或功能…（也可以粘贴/拖放图片）",
    "변경 사항, 버그 또는 기능을 설명하세요… (이미지도 붙여넣기/드롭 가능)",
    "変更、バグ、または機能について説明してください…（画像も貼り付け/ドラッグ＆ドロップ可能）",
    "وصف التغيير أو الخطأ أو الميزة… (يمكنك أيضًا لصق/إسقاط الصور) ",
    "Descrivi il cambiamento, il bug o la funzionalità… (incolla/trascina anche immagini)"
  ],
  [
    "Describe what this agent does.",
    "描述该代理的功能。",
    "이 에이전트가 수행하는 작업을 설명하십시오.",
    "このエージェントが何をするか説明してください。",
    "وصف ما يفعله هذا الوكيل.",
    "Descrivi cosa fa questo agente."
  ],
  [
    "Describe what's wrong, then send this view + diagnostics + any screenshot to the OwLLM team.",
    "描述问题，然后将此视图 + 诊断信息 + 任意截图发送给 OwLLM 团队。",
    "문제가 무엇인지 설명한 후 이 뷰 + 진단 + 스크린샷을 OwLLM 팀에 보내십시오.",
    "何が問題か説明し、このビューと診断情報、およびスクリーンショットをOwLLMチームに送ってください。",
    "وصف ما هو خطأ، ثم أرسل هذه النظرة + التشخيصات + أي لقطة شاشة إلى فريق OwLLM.",
    "Descrivi cosa non va, poi invia questa vista + diagnostica + eventuale screenshot al team OwLLM."
  ],
  [
    "Description",
    "描述",
    "설명",
    "説明",
    "الوصف",
    "Descrizione"
  ],
  [
    "Description (optional)",
    "描述（可选）",
    "설명 (선택 사항)",
    "説明（オプション）",
    "الوصف (اختياري)",
    "Descrizione (opzionale)"
  ],
  [
    "design",
    "设计",
    "디자인",
    "デザイン",
    "تصميم",
    "Design"
  ],
  [
    "Design",
    "设计",
    "디자인",
    "デザイン",
    "تصميم",
    "Design"
  ],
  [
    "Design individual agents — pick an avatar, a job, the tools they get to use. Built-ins ship with OWLLM and can't be edited; click Duplicate on any built-in to make your own copy.",
    "设计独立代理——选择头像、工作以及他们可以使用的工具。内置功能随 OWLLM 一起提供，无法编辑；点击任何内置功能上的“复制”以创建你自己的副本。",
    "개별 에이전트를 디자인하세요 — 아바타, 직업, 사용할 도구를 선택하세요. 내장된 기능은 OWLLM과 함께 제공되며 수정할 수 없고, 내장 기능의 '복제'를 클릭하면 자신의 사본을 만들 수 있습니다.",
    "個々のエージェントを設計します — アバター、仕事、使用するツールを選択します。組み込みのものはOWLLMに付属しており、編集できません；任意の組み込みアイテムで「複製」をクリックして自分のコピーを作成します。",
    "تصميم وكلاء فرديين — اختر صورة رمزية، وظيفة، والأدوات التي يمكنهم استخدامها. تأتي الأدوات المدمجة مع OWLLM ولا يمكن تعديلها؛ انقر على تكرار على أي أداة مدمجة لإنشاء نسختك الخاصة.",
    "Progetta agenti individuali — scegli un avatar, un lavoro, gli strumenti che possono usare. I predefiniti sono forniti con OWLLM e non possono essere modificati; fai clic su Duplica su qualsiasi predefinito per creare la tua copia."
  ],
  [
    "Destination path on the remote host.",
    "远程主机上的目标路径。",
    "원격 호스트의 대상 경로.",
    "リモートホスト上の宛先パス。",
    "مسار الوجهة على المضيف البعيد.",
    "Percorso di destinazione sull'host remoto."
  ],
  [
    "Destination path on this machine.",
    "此机器上的目标路径。",
    "이 컴퓨터의 대상 경로.",
    "このマシン上の宛先パス。",
    "مسار الوجهة على هذه الآلة.",
    "Percorso di destinazione su questa macchina."
  ],
  [
    "detached HEAD",
    "分离的 HEAD",
    "분리된 HEAD",
    "detached HEAD",
    "رأس مفصول",
    "HEAD staccato"
  ],
  [
    "Detected GPU:",
    "检测到的 GPU:",
    "감지된 GPU:",
    "検出されたGPU:",
    "تم اكتشاف GPU:",
    "GPU rilevata:"
  ],
  [
    "Developer ID Application: Your Name (TEAMID)",
    "开发者ID申请：你的名字（TEAMID）",
    "개발자 ID 애플리케이션: Your Name (TEAMID)",
    "開発者ID申請: あなたの名前 (TEAMID)",
    "تطبيق معرف المطور: اسمك (TEAMID)",
    "Applicazione ID Sviluppatore: Il Tuo Nome (TEAMID)"
  ],
  [
    "device",
    "设备",
    "장치",
    "デバイス",
    "الجهاز",
    "DISPOSITIVO"
  ],
  [
    "DEVICE",
    "设备",
    "장치",
    "デバイス",
    "جهاز",
    "DISPOSITIVO"
  ],
  [
    "device IP / hostname",
    "设备IP / 主机名",
    "장치 IP / 호스트 이름",
    "デバイスIP / ホスト名",
    "عنوان IP / اسم المضيف للجهاز",
    "IP / hostname del dispositivo"
  ],
  [
    "Diagnostics (read-only)",
    "诊断（只读）",
    "진단 (읽기 전용)",
    "診断（読み取り専用）",
    "تشخيصات (للقراءة فقط)",
    "Diagnostica (sola lettura)"
  ],
  [
    "diagram",
    "图表",
    "다이어그램",
    "図",
    "مخطط",
    "diagramma"
  ],
  [
    "different skill to switch skills mid-task, as many times as needed.",
    "在任务中切换技能所需的不同技能，可根据需要多次切换。",
    "작업 중간에 필요한 만큼 여러 번 기술을 전환하는 다른 기술.",
    "タスクの途中でスキルを切り替える異なるスキル、必要に応じて何度でも。",
    "مهارة مختلفة لتبديل المهارات أثناء المهمة، بقدر ما يلزم.",
    "diversa abilità di cambiare abilità a metà attività, tutte le volte necessarie."
  ],
  [
    "Digest agent model. Default: the team's model (pending override -> project's team model -> loaded server model).",
    "Digest代理模型。默认：团队的模型（待覆盖 -> 项目的团队模型 -> 加载的服务器模型）。",
    "에이전트 모델 소화. 기본값: 팀의 모델 (재정의 보류 -> 프로젝트의 팀 모델 -> 로드된 서버 모델).",
    "ダイジェストエージェントモデル。デフォルト: チームのモデル（上書き保留 -> プロジェクトのチームモデル -> 読み込まれたサーバーモデル）。",
    "نموذج وكيل الهضم. الافتراضي: نموذج الفريق (في انتظار التجاوز -> نموذج فريق المشروع -> نموذج الخادم المحمل).",
    "Modello agente Digest. Predefinito: il modello del team (sovrascrittura in sospeso -> modello del team del progetto -> modello server caricato)."
  ],
  [
    "Digest the current notebook into a clearer plan and new feedable steps.",
    "将当前笔记本消化成更清晰的计划和可执行的新步骤。",
    "현재 노트북을 더 명확한 계획과 새로 제공할 수 있는 단계로 소화하세요.",
    "現在のノートをより明確な計画と新しい実行可能なステップに消化する。",
    "استوعب الدفتر الحالي في خطة أوضح وخطوات جديدة قابلة للتنفيذ.",
    "Elabora il taccuino attuale in un piano più chiaro e nuovi passaggi alimentabili."
  ],
  [
    "Digest the working notes, current plan, and existing steps",
    "消化工作笔记、当前计划和现有步骤",
    "작업 노트, 현재 계획 및 기존 단계를 소화",
    "作業メモ、現在の計画、既存のステップをダイジェストする",
    "هضم الملاحظات العملية والخطة الحالية والخطوات الموجودة",
    "Assimila le note di lavoro, il piano attuale e i passaggi esistenti"
  ],
  [
    "Digest transcript",
    "消化记录",
    "전사 기록 소화",
    "トランスクリプトをダイジェストする",
    "هضم النسخة الخطية",
    "Trascrizione del digest"
  ],
  [
    "Digesting...",
    "正在消化...",
    "소화 중...",
    "ダイジェスト中...",
    "جاري الهضم...",
    "Digestione in corso..."
  ],
  [
    "director mode (critic stands in for me)",
    "导演模式（批评者代替我）",
    "디렉터 모드 (비평가가 나를 대신함)",
    "ディレクターモード（批評家が私の代わりを務める）",
    "وضع المدير (الناقد يحل محلي)",
    "modalità direttore (il critico prende il mio posto)"
  ],
  [
    "Directory root for the search. Defaults to '.' (project cwd).",
    "搜索的目录根。默认值为 '.'（项目当前工作目录）。",
    "검색을 위한 디렉터리 루트. 기본값은 '.' (프로젝트 현재 작업 디렉터리).",
    "検索のルートディレクトリ。デフォルトは '.'（プロジェクトのカレントディレクトリ）。",
    "جذر الدليل للبحث. الافتراضي هو '.' (دليل المشروع الحالي).",
    "Cartella principale per la ricerca. Predefinita su '.' (cartella di lavoro del progetto)."
  ],
  [
    "Directory to search under. Defaults to '.' (project cwd).",
    "要搜索的目录。默认值为 '.'（项目当前工作目录）。",
    "검색할 하위 디렉터리. 기본값은 '.' (프로젝트 현재 작업 디렉터리).",
    "検索するディレクトリ。デフォルトは '.'（プロジェクトのカレントディレクトリ）。",
    "الدليل للبحث تحته. الافتراضي هو '.' (دليل المشروع الحالي).",
    "Cartella in cui eseguire la ricerca. Predefinita su '.' (cartella di lavoro del progetto)."
  ],
  [
    "Directs its own members — a sub-orchestrator. Only it talks to its boss; the agents it dispatches to are its team.",
    "指导自己的成员——一个子指挥者。只有它与它的老板交谈；它派遣的代理是它的团队。",
    "자신의 구성원들을 지휘하는 - 하위 지휘자. 오직 자신만이 상사와 이야기하며; 자신이 파견하는 요원들은 자신의 팀이다.",
    "自分自身のメンバーを指揮する — サブオーケストレーター。自分だけが上司と話す；派遣されるエージェントは自分のチームです。",
    "يوجه أعضاؤه الخاصون — منسق فرعي. هو فقط من يتحدث إلى رئيسه؛ الوكلاء الذين يرسلهم هم فريقه.",
    "Dirige i propri membri — un sotto-orchestratore. Solo lui parla con il suo capo; gli agenti che invia sono il suo team."
  ],
  [
    "disable remote control",
    "禁用远程控制",
    "원격 제어 비활성화",
    "リモートコントロールを無効にする",
    "تعطيل التحكم عن بعد",
    "disabilita controllo remoto"
  ],
  [
    "disabled",
    "已禁用",
    "비활성화됨",
    "無効",
    "معطل",
    "disabilitato"
  ],
  [
    "Disabled — hidden from agents",
    "已禁用——对代理隐藏",
    "사용 불가 - 요원에게서 숨겨짐",
    "無効 — エージェントからは隠されています",
    "معاق — مخفي عن الوكلاء",
    "Disabilitato — nascosto agli agenti"
  ],
  [
    "Discard",
    "放弃",
    "버리기",
    "破棄",
    "تجاهل",
    "Scarta"
  ],
  [
    "Discard changes and stop editing",
    "放弃更改并停止编辑",
    "변경 사항을 버리고 편집 중지",
    "変更を破棄して編集を停止",
    "تجاهل التغييرات وتوقف عن التحرير",
    "Scarta le modifiche e interrompi la modifica"
  ],
  [
    "Discard proposed steps",
    "放弃提议的步骤",
    "제안된 단계 버리기",
    "提案されたステップを破棄",
    "تجاهل الخطوات المقترحة",
    "Scarta i passaggi proposti"
  ],
  [
    "Discard steps",
    "放弃步骤",
    "단계 버리기",
    "ステップを破棄",
    "تجاهل الخطوات",
    "Scarta passaggi"
  ],
  [
    "Discard the proposed plan",
    "放弃提议的计划",
    "제안된 계획 버리기",
    "提案された計画を破棄",
    "تجاهل الخطة المقترحة",
    "Scartare il piano proposto"
  ],
  [
    "Discard this new project and close?",
    "放弃这个新项目并关闭？",
    "이 새 프로젝트를 버리고 닫으시겠습니까?",
    "この新しいプロジェクトを破棄して閉じますか？",
    "تجاهل هذا المشروع الجديد وإغلاقه؟",
    "Scartare questo nuovo progetto e chiudere?"
  ],
  [
    "Discard unsaved changes to this file?",
    "放弃对该文件的未保存更改？",
    "이 파일의 저장되지 않은 변경 사항을 버리시겠습니까?",
    "このファイルの保存されていない変更を破棄しますか？",
    "تجاهل التغييرات غير المحفوظة في هذا الملف؟",
    "Scartare le modifiche non salvate a questo file?"
  ],
  [
    "Disconnect",
    "断开连接",
    "연결 끊기",
    "切断",
    "قطع الاتصال",
    "Disconnetti"
  ],
  [
    "Discord",
    "Discord（不译）",
    "디스코드",
    "ディスコード",
    "ديسكورد",
    "Discord"
  ],
  [
    "discover a skill you can load_skill() into context for the current task.",
    "发现一个可以通过 load_skill() 加入当前任务上下文的技能。",
    "현재 작업에 대해 load_skill()로 불러올 수 있는 기술을 발견하세요.",
    "現在のタスクのコンテキストに load_skill() できるスキルを発見する。",
    "اكتشف مهارة يمكنك تحميلها load_skill() في السياق للمهمة الحالية.",
    "scoprire una skill che puoi caricare con load_skill() nel contesto per il compito corrente."
  ],
  [
    "Discuss/review only — no edits, no state-changing commands",
    "仅讨论/回顾 — 不要编辑，不要执行会改变状态的命令",
    "논의/검토만 — 편집 금지, 상태 변경 명령 금지",
    "議論／レビューのみ — 編集や状態を変更するコマンドはなし",
    "ناقش/استعرض فقط — لا تعديلات، لا أوامر لتغيير الحالة",
    "Discutere/rivedere solo — nessuna modifica, nessun comando che cambi lo stato"
  ],
  [
    "Dismiss",
    "忽略",
    "거부",
    "却下",
    "رفض",
    "Ignora"
  ],
  [
    "dispatch to (or hand output to)",
    "分派到（或将输出交给）",
    "(또는 출력 전달) 배정",
    "（または出力を）送信",
    "إرسال إلى (أو تمرير الناتج إلى)",
    "invia a (o consegna l'output a)"
  ],
  [
    "dispatched",
    "已分派",
    "배정됨",
    "送信済み",
    "تم الإرسال",
    "inviato"
  ],
  [
    "dispatched as a new goal",
    "已作为新目标分派",
    "새 목표로 배정됨",
    "新しい目標として送信済み",
    "تم الإرسال كهدف جديد",
    "inviato come nuovo obiettivo"
  ],
  [
    "dispatching",
    "分派中",
    "배정 중",
    "送信中",
    "الإرسال",
    "invio in corso"
  ],
  [
    "Dispatching{0}",
    "调度{0}",
    "배치{0}",
    "ディスパッチ{0}",
    "إرسال{0}",
    "Invio{0}"
  ],
  [
    "distro, a stripped-down userland with no",
    "发行版，一个没有用户界面的精简系统",
    "distro, 최소화된 사용자 공간",
    "ユーザーランドを削ぎ落としたディストロ",
    "توزيع، بيئة مستخدم مبسطة بدون",
    "distro, un userland ridotto senza"
  ],
  [
    "Docker Desktop's",
    "Docker Desktop 的",
    "Docker Desktop의",
    "Docker Desktop の",
    "Docker Desktop's",
    "Docker Desktop"
  ],
  [
    "documentation, etc.",
    "文档等。",
    "문서 등",
    "ドキュメントなど",
    "التوثيق، إلخ.",
    "documentazione, ecc."
  ],
  [
    "Documents",
    "文件",
    "문서",
    "書類",
    "وثائق",
    "Documenti"
  ],
  [
    "documents + URLs → instruction/output JSONL",
    "文档 + URL → 指令/输出 JSONL",
    "문서 + URL → 지시문/출력 JSONL",
    "ドキュメント + URL → 指示/出力 JSONL",
    "المستندات + عناوين URL → تعليمات/مخرجات JSONL",
    "documenti + URL → istruzione/output JSONL"
  ],
  [
    "does NOT code-sign",
    "不进行代码签名",
    "코드 서명하지 않음",
    "コード署名されていません",
    "لا يقوم بالتوقيع البرمجي",
    "NON firma il codice"
  ],
  [
    "Does the work the orchestrator dispatches.",
    "执行调度器分派的工作。",
    "오케스트레이터가 전달하는 작업을 수행합니다.",
    "オーケストレーターが派遣する作業を行います。",
    "يقوم بالعمل الذي يرسله منسق العمليات.",
    "Esegue il lavoro che l'orchestratore invia."
  ],
  [
    "Don't close the app — it will restart automatically when ready.",
    "不要关闭应用程序 —— 准备好后会自动重启。",
    "앱을 닫지 마세요 — 준비되면 자동으로 재시작됩니다.",
    "アプリを閉じないでください — 準備ができると自動的に再起動します。",
    "لا تغلق التطبيق — سيعاد تشغيله تلقائيًا عند الاستعداد.",
    "Non chiudere l'app — si riavvierà automaticamente quando pronto."
  ],
  [
    "Don't show again",
    "不再显示",
    "다시 표시하지 않기",
    "再表示しない",
    "لا تُظهر مرة أخرى",
    "Non mostrare di nuovo"
  ],
  [
    "done",
    "完成",
    "완료",
    "完了",
    "تم",
    "Fatto"
  ],
  [
    "Done",
    "完成",
    "완료",
    "完了",
    "تم",
    "Fatto"
  ],
  [
    "Done — {0} pair(s) from {1} chunk(s). Review below, then Save.",
    "完成 —— 从 {1} 个块中生成了 {0} 对。请查看下方内容，然后保存。",
    "완료 — {1} 청크에서 {0} 쌍이 생성되었습니다. 아래를 검토한 후 저장하세요.",
    "完了 — {1}チャンクから{0}ペア。以下を確認してから保存してください。",
    "تم — {0} زوج/أزواج من {1} جزء/أجزاء. راجع أدناه، ثم احفظ.",
    "Fatto — {0} coppia(e) da {1} blocco(i). Rivedi sotto, poi Salva."
  ],
  [
    "down_proj",
    "down_proj",
    "down_proj",
    "down_proj",
    "down_proj",
    "down_proj"
  ],
  [
    "Download",
    "下载",
    "다운로드",
    "ダウンロード",
    "تحميل",
    "Scarica"
  ],
  [
    "Download + install the local llama.cpp inference engine for your GPU",
    "下载 + 安装适用于你的 GPU 的本地 llama.cpp 推理引擎",
    "GPU용 로컬 llama.cpp 추론 엔진을 다운로드하고 설치하세요",
    "GPU 用ローカル llama.cpp 推論エンジンをダウンロードおよびインストール",
    "تحميل + تثبيت محرك الاستدلال المحلي llama.cpp لبطاقة الرسومات الخاصة بك",
    "Scarica + installa il motore di inferenza locale llama.cpp per la tua GPU"
  ],
  [
    "Download failed: {0}",
    "下载失败: {0}",
    "다운로드 실패: {0}",
    "ダウンロード失敗: {0}",
    "فشل التحميل: {0}",
    "Download fallito: {0}"
  ],
  [
    "Download the base model first — use the Download button under Base Model.",
    "先下载基础模型 —— 使用基础模型下的下载按钮。",
    "기본 모델을 먼저 다운로드하세요 — 기본 모델 아래의 다운로드 버튼을 사용하세요.",
    "まずベースモデルをダウンロードしてください — ベースモデルの下にあるダウンロードボタンを使用します。",
    "قم بتنزيل النموذج الأساسي أولاً — استخدم زر التنزيل تحت النموذج الأساسي.",
    "Scarica prima il modello base — usa il pulsante Scarica sotto Modello Base."
  ],
  [
    "downloaded",
    "已下载",
    "다운로드됨",
    "ダウンロード済み",
    "تم التحميل",
    "scaricato"
  ],
  [
    "Downloaded models",
    "已下载的模型",
    "다운로드된 모델",
    "ダウンロードされたモデル",
    "النماذج المحملة",
    "Modelli scaricati"
  ],
  [
    "downloading",
    "下载中",
    "다운로드 중",
    "ダウンロード中",
    "جارٍ التحميل",
    "scaricamento in corso"
  ],
  [
    "Downloading {0} / {1} MB",
    "下载 {0} / {1} MB",
    "{0} / {1} MB 다운로드 중",
    "{0} / {1} MB をダウンロード中",
    "تحميل {0} / {1} ميغابايت",
    "Scaricando {0} / {1} MB"
  ],
  [
    "Downloading model (~142 MB)",
    "正在下载模型 (~142 MB)",
    "모델 다운로드 중 (~142 MB)",
    "モデルをダウンロード中（約142 MB）",
    "تحميل النموذج (~142 ميغابايت)",
    "Scaricando modello (~142 MB)"
  ],
  [
    "Downloading whisper.cpp binary",
    "正在下载 whisper.cpp 二进制文件",
    "whisper.cpp 바이너리 다운로드 중",
    "whisper.cpp バイナリをダウンロード中",
    "تحميل ملف whisper.cpp التنفيذي",
    "Scaricando il binario di whisper.cpp"
  ],
  [
    "Downloading…",
    "下载中…",
    "다운로드 중…",
    "ダウンロード中…",
    "جارٍ التنزيل…",
    "Download in corso…"
  ],
  [
    "Downloading… {0}%{1}",
    "下载中… {0}%{1}",
    "다운로드 중… {0}%{1}",
    "ダウンロード中… {0}%{1}",
    "جارٍ التنزيل… {0}%{1}",
    "Download in corso… {0}%{1}"
  ],
  [
    "downloads",
    "下载",
    "다운로드",
    "ダウンロード",
    "التحميلات",
    "download"
  ],
  [
    "draft",
    "草稿",
    "초안",
    "下書き",
    "مسودة",
    "Bozza"
  ],
  [
    "Draft",
    "草稿",
    "초안",
    "下書き",
    "مسودة",
    "Bozza"
  ],
  [
    "Draft release",
    "草稿发布",
    "초안 릴리스",
    "ドラフトリリース",
    "الإصدار التجريبي",
    "Versione di prova"
  ],
  [
    "Drag a .jsonl here, or browse...",
    "将 .jsonl 文件拖到此处，或浏览…",
    "여기에 .jsonl 파일을 드래그하거나 찾아보기...",
    ".jsonl をここにドラッグするか、参照...",
    "اسحب ملف .jsonl هنا، أو استعرض...",
    "Trascina un .jsonl qui, oppure sfoglia…"
  ],
  [
    "Drag from a blue output port → drop on another card to wire a dispatch edge. Click an edge to select it, then ✕ Edge / ⇄ Reverse.",
    "从蓝色输出端口拖动 → 放到另一张卡片上以连接调度边。点击一条边以选择它，然后 ✕ 边 / ⇄ 反转。",
    "파란 출력 포트에서 끌어 다른 카드에 놓아 전송 엣지를 연결합니다. 엣지를 클릭하여 선택한 후 ✕ 엣지 / ⇄ 반전.",
    "青い出力ポートからドラッグ → 別のカードにドロップしてディスパッチエッジを接続します。エッジをクリックして選択し、✕ エッジ / ⇄ 反転。",
    "اسحب من منفذ الإخراج الأزرق → أسقط على بطاقة أخرى لتوصيل حافة الإرسال. انقر على الحافة لتحديدها، ثم ✕ الحافة / ⇄ عكس.",
    "Trascina da una porta di uscita blu → rilascia su un'altra scheda per collegare un bordo di dispatch. Fai clic su un bordo per selezionarlo, quindi ✕ Bordo / ⇄ Inverti."
  ],
  [
    "Drag to another agent to create a dispatch edge",
    "拖动到另一个代理以创建分派边",
    "다른 에이전트로 드래그하여 디스패치 엣지 생성",
    "別のエージェントにドラッグしてディスパッチエッジを作成",
    "اسحب إلى وكيل آخر لإنشاء حافة توزيع",
    "Trascina su un altro agente per creare un bordo di invio"
  ],
  [
    "Drag to resize",
    "拖动以调整大小",
    "드래그하여 크기 조절",
    "ドラッグしてサイズ変更",
    "اسحب لتغيير الحجم",
    "Trascina per ridimensionare"
  ],
  [
    "Drive your agent team from a phone. Telegram needs only a bot token; WhatsApp Cloud API needs a public webhook URL — point a tunnel (cloudflared / ngrok) at the local port and copy that URL into the Meta App webhook config.",
    "从手机驱动你的代理团队。Telegram 只需要一个机器人令牌；WhatsApp 云 API 需要一个公共 webhook URL — 将隧道（cloudflared / ngrok）指向本地端口，然后将该 URL 复制到 Meta 应用的 webhook 配置中。",
    "휴대폰에서 에이전트 팀을 운영하세요. 텔레그램은 봇 토큰만 필요하고, WhatsApp 클라우드 API는 공개 웹훅 URL이 필요합니다 — 터널(cloudflared / ngrok)을 로컬 포트에 연결하고 그 URL을 Meta 앱 웹훅 설정에 복사하세요.",
    "電話からエージェントチームを操作します。Telegramにはボットトークンだけが必要です；WhatsApp Cloud APIには公開ウェブフックURLが必要です — トンネル（cloudflared / ngrok）をローカルポートに向け、そのURLをMetaアプリのウェブフック設定にコピーします。",
    "قم بتشغيل فريق الوكلاء الخاص بك من الهاتف. تيليجرام يحتاج فقط إلى رمز الروبوت؛ واجهة برمجة تطبيقات واتساب كلاود تحتاج إلى عنوان URL ويب هوك عام — قم بتوجيه نفق (cloudflared / ngrok) إلى المنفذ المحلي وانسخ هذا العنوان في تكوين ويب هوك تطبيق Meta.",
    "Gestisci il tuo team di agenti da un telefono. Telegram richiede solo un token del bot; l'API WhatsApp Cloud necessita di un URL webhook pubblico — punta un tunnel (cloudflared / ngrok) alla porta locale e copia quell'URL nella configurazione del webhook dell'app Meta."
  ],
  [
    "Drop this pair",
    "删除此对",
    "이 쌍 삭제",
    "このペアを削除",
    "أسقط هذه الزوجية",
    "Rilascia questa coppia"
  ],
  [
    "Dry run",
    "试运行",
    "건식 실행",
    "ドライラン",
    "تجربة جافة",
    "Esecuzione di prova"
  ],
  [
    "dry-run",
    "模拟运行",
    "드라이런",
    "dry-run",
    "تشغيل تجريبي",
    "dry-run"
  ],
  [
    "Duplicate",
    "复制",
    "중복",
    "複製",
    "استنساخ",
    "Duplica"
  ],
  [
    "Duplicate failed: {0}",
    "复制失败：{0}",
    "중복 실패: {0}",
    "複製に失敗しました: {0}",
    "فشل الاستنساخ: {0}",
    "Duplicazione fallita: {0}"
  ],
  [
    "duplicating it. The runtime detects these lines and saves them automatically; if",
    "复制它。运行时会检测这些行并自动保存；如果",
    "중복.\n런타임이 이러한 라인을 감지하고 자동으로 저장합니다; 만약",
    "これを複製しています。ランタイムはこれらの行を検出して自動的に保存します；もし",
    "تكراره. يكتشف وقت التشغيل هذه السطور ويحفظها تلقائيًا؛ إذا",
    "duplicandolo. Il runtime rileva queste righe e le salva automaticamente; se"
  ],
  [
    "Durable knowledge — synced across your PCs via the vault",
    "持久知识 — 通过保险库在你的电脑间同步",
    "지속적인 지식 — 금고를 통해 PC 간에 동기화됨",
    "耐久性のある知識 — バルトを通じてPC間で同期されます",
    "المعرفة الدائمة — متزامنة عبر أجهزة الكمبيوتر الخاصة بك عبر الخزانة",
    "Conoscenza durevole — sincronizzata tra i tuoi PC tramite la cassaforte"
  ],
  [
    "e.g. . · owllm-desktop",
    "例如 . · owllm-desktop",
    "예: . · owllm-desktop",
    "例：. · owllm-desktop",
    "مثال . · owllm-desktop",
    "es. . · owllm-desktop"
  ],
  [
    "e.g. 8A1C…",
    "例如 8A1C…",
    "예: 8A1C…",
    "例：8A1C…",
    "مثال 8A1C…",
    "es. 8A1C…"
  ],
  [
    "e.g. A Gmail-native CRM I can use for my own business contacts. Or: a workout tracker that learns from my history and suggests next week's plan.",
    "例如 一个 Gmail 原生的 CRM，我可以用来管理自己的商业联系人。或者：一个根据我的历史学习并建议下周计划的锻炼追踪器。",
    "예: 내 비즈니스 연락처에 사용할 수 있는 Gmail-기반 CRM. 또는: 내 이력을 학습하고 다음 주 계획을 제안하는 운동 추적기.",
    "例: 自分のビジネス連絡先に使えるGmailネイティブのCRM。または、私の履歴から学習し、来週のプランを提案するワークアウトトラッカー。",
    "مثال: نظام إدارة علاقات العملاء المدمج مع Gmail الذي يمكنني استخدامه لجهات الاتصال الخاصة بأعمالي. أو: متتبع التمارين الذي يتعلم من تاريخي ويقترح خطة الأسبوع القادم.",
    "ad es. Un CRM nativo di Gmail che posso usare per i miei contatti aziendali. Oppure: un tracker di allenamento che impara dalla mia storia e suggerisce il piano della prossima settimana."
  ],
  [
    "e.g. Agents won't run isolated even though WSL is ready — it tells me to install the training env, which makes no sense.",
    "例如，即使 WSL 已就绪，代理也不会单独运行——它告诉我安装训练环境，这没有任何意义。",
    "예: 에이전트는 WSL이 준비되어 있어도 독립적으로 실행되지 않음 — 훈련 환경을 설치하라고 하며, 이는 말이 되지 않음.",
    "例: エージェントはWSLが準備できていても単独で実行されません — トレーニング環境をインストールするように指示されますが、意味がありません。",
    "على سبيل المثال، الوكلاء لن يعملوا بشكل معزول على الرغم من أن WSL جاهز — يخبرني بتثبيت بيئة التدريب، وهو أمر غير منطقي.",
    "ad esempio, gli agenti non funzioneranno isolati anche se WSL è pronto — mi dice di installare l'ambiente di formazione, il che non ha senso."
  ],
  [
    "e.g. bash scripts/publish.sh --notes \"$OWLLM_RELEASE_NOTES\"",
    "例如 bash scripts/publish.sh --notes \"$OWLLM_RELEASE_NOTES\"",
    "예: bash scripts/publish.sh --notes \"$OWLLM_RELEASE_NOTES\"",
    "例えば、bash scripts/publish.sh --notes \"$OWLLM_RELEASE_NOTES\"",
    "مثال: bash scripts/publish.sh --notes \"$OWLLM_RELEASE_NOTES\"",
    "ad es. bash scripts/publish.sh --notes \"$OWLLM_RELEASE_NOTES\""
  ],
  [
    "e.g. esp-flash, cleanup-pr, paper-draft",
    "例如 esp-flash, cleanup-pr, paper-draft",
    "예: esp-flash, cleanup-pr, paper-draft",
    "例えば、esp-flash、cleanup-pr、paper-draft",
    "مثال: esp-flash، cleanup-pr، paper-draft",
    "ad es. esp-flash, cleanup-pr, paper-draft"
  ],
  [
    "e.g. my-app",
    "例如 my-app",
    "예: my-app",
    "例えば、my-app",
    "مثال: my-app",
    "ad es. my-app"
  ],
  [
    "e.g. never mock data — always real DB calls",
    "例如，永远不要模拟数据——始终使用真实的数据库调用",
    "예: 데이터를 절대 모킹하지 말 것 — 항상 실제 DB 호출",
    "例: データを絶対にモックしない — 常に実際のDB呼び出しを行う",
    "على سبيل المثال، لا تقوم أبدًا بمحاكاة البيانات — دائمًا استخدم المكالمات الحقيقية لقاعدة البيانات",
    "ad esempio, non simulare mai i dati — sempre chiamate reali al DB"
  ],
  [
    "e.g. package.json · src-tauri/tauri.conf.json",
    "例如，package.json · src-tauri/tauri.conf.json",
    "예: package.json · src-tauri/tauri.conf.json",
    "例: package.json · src-tauri/tauri.conf.json",
    "على سبيل المثال، package.json · src-tauri/tauri.conf.json",
    "ad esempio, package.json · src-tauri/tauri.conf.json"
  ],
  [
    "e.g. Your Company Ltd",
    "例如 你的公司有限公司",
    "예: Your Company Ltd",
    "例えば、Your Company Ltd",
    "مثال: شركتك المحدودة",
    "ad es. La Tua Azienda Srl"
  ],
  [
    "e.g. your-org/your-app — empty = the publish script&apos;s default",
    "例如，your-org/your-app — 空 = 发布脚本的默认值",
    "예: your-org/your-app — 비어 있음 = 게시 스크립트의 기본값",
    "例: your-org/your-app — 空の場合 = パブリッシュスクリプトのデフォルト",
    "على سبيل المثال، your-org/your-app — فارغ = هو الافتراضي لبرنامج النشر",
    "ad esempio, your-org/your-app — vuoto = predefinito dello script di pubblicazione"
  ],
  [
    "Each generated instruction/output pair will appear here for review.",
    "每个生成的指令/输出对将显示在此供审核。",
    "각 생성된 명령/출력 쌍은 검토를 위해 여기에 나타납니다.",
    "ここに生成された各指示/出力のペアがレビュー用に表示されます。",
    "كل زوج من التعليمات/المخرجات المولدة سيظهر هنا للمراجعة.",
    "Ogni coppia istruzione/output generata apparirà qui per la revisione."
  ],
  [
    "Each provider gets one card with both ways to access it: subscription (CLI login or web portal) and API key. Install / Connect output streams live into the right-side log — no pop-out console.",
    "每个提供者都会获得一张卡，卡上有两种访问方式：订阅（CLI 登录或网页门户）和 API 密钥。安装/连接输出流实时显示在右侧日志中——无需弹出控制台。",
    "각 제공자는 한 장의 카드를 받아 접근 방법 두 가지를 모두 제공합니다: 구독(CLI 로그인 또는 웹 포털) 및 API 키. 설치 / 연결 출력 스트림을 오른쪽 로그에 실시간으로 연결 — 팝아웃 콘솔 없음.",
    "各プロバイダーは、サブスクリプション（CLIログインまたはウェブポータル）とAPIキーという両方のアクセス方法がある1枚のカードを受け取ります。インストール／接続した出力ストリームは右側のログにライブで表示されます — ポップアウトコンソールはありません。",
    "يحصل كل مزود على بطاقة واحدة مع طريقتين للوصول إليها: الاشتراك (تسجيل الدخول عبر CLI أو بوابة الويب) ومفتاح API. قم بتثبيت / توصيل تدفقات الإخراج مباشرة إلى السجل على الجانب الأيمن — بدون وحدة تحكم منبثقة.",
    "Ogni fornitore riceve una scheda con entrambi i modi per accedervi: abbonamento (login CLI o portale web) e chiave API. Installa / collega i flussi di output direttamente nel registro sul lato destro — nessuna console a comparsa."
  ],
  [
    "edge",
    "边缘",
    "에지",
    "エッジ",
    "الحافة",
    "edge"
  ],
  [
    "edit",
    "编辑",
    "편집",
    "編集",
    "تحرير",
    "Modifica"
  ],
  [
    "Edit",
    "编辑",
    "편집",
    "編集",
    "تحرير",
    "Modifica"
  ],
  [
    "Edit {0} — model · colour · prompt",
    "编辑 {0} — 模型 · 颜色 · 提示",
    "{0} 편집 — 모델 · 색상 · 프롬프트",
    "{0} を編集 — モデル・色・プロンプト",
    "تحرير {0} — النموذج · اللون · الموجه",
    "Modifica {0} — modello · colore · prompt"
  ],
  [
    "Edit Server: {0}",
    "编辑服务器：{0}",
    "서버 편집: {0}",
    "サーバーを編集: {0}",
    "تحرير الخادم: {0}",
    "Modifica Server: {0}"
  ],
  [
    "Edit team — {0}",
    "编辑团队 — {0}",
    "팀 편집 — {0}",
    "チームを編集 — {0}",
    "تحرير الفريق — {0}",
    "Modifica team — {0}"
  ],
  [
    "Edit team identity",
    "编辑团队身份",
    "팀 아이덴티티 편집",
    "チームのアイデンティティを編集",
    "تحرير هوية الفريق",
    "Modifica identità del team"
  ],
  [
    "Edit this agent's model, card colour and prompt. Save writes them into the team template.",
    "编辑此代理的模型、卡片颜色和提示。保存会将其写入团队模板。",
    "이 에이전트의 모델, 카드 색상 및 프롬프트를 편집하세요. 저장하면 팀 템플릿에 작성 내용이 기록됩니다.",
    "このエージェントのモデル、カードの色、プロンプトを編集します。保存するとチームテンプレートに書き込まれます。",
    "تحرير نموذج هذا الوكيل، ولون البطاقة، والموجه. الحفظ يكتبها في قالب الفريق.",
    "Modifica il modello di questo agente, il colore della carta e il prompt. Salva li scrive nel modello del team."
  ],
  [
    "Edit this file",
    "编辑此文件",
    "이 파일 편집",
    "このファイルを編集",
    "حرر هذا الملف",
    "Modifica questo file"
  ],
  [
    "Edit-focused prompt",
    "以编辑为中心的提示",
    "편집 중심 프롬프트",
    "編集重視のプロンプト",
    "موجه مركز على التحرير",
    "Prompt incentrato sulla modifica"
  ],
  [
    "Element index from the latest browser_snapshot.",
    "最新浏览器快照中的元素索引。",
    "최신 browser_snapshot에서 요소 인덱스.",
    "最新のブラウザスナップショットからの要素インデックス。",
    "فهرس العنصر من أحدث لقطة للمتصفح.",
    "Indice elemento dall'ultimo browser_snapshot."
  ],
  [
    "Email",
    "电子邮件",
    "이메일",
    "メール",
    "البريد الإلكتروني",
    "Email"
  ],
  [
    "embed_tokens",
    "嵌入令牌",
    "임베드_토큰",
    "埋め込みトークン",
    "تضمين الرموز",
    "embed_tokens"
  ],
  [
    "Emerald",
    "翡翠",
    "에메랄드",
    "エメラルド",
    "زمرد",
    "Smeraldo"
  ],
  [
    "Emergency stop — cancel every in-flight remote command + session",
    "紧急停止——取消所有正在执行的远程命令和会话",
    "비상 정지 — 비행 중 모든 원격 명령과 세션 취소",
    "緊急停止 — 飛行中のすべてのリモートコマンドとセッションをキャンセル",
    "الإيقاف الطارئ — إلغاء كل أمر عن بُعد أثناء الطيران + الجلسة",
    "Arresto d'emergenza — annulla ogni comando remoto in volo + sessione"
  ],
  [
    "Empty",
    "空",
    "비어 있음",
    "空",
    "فارغ",
    "Vuoto"
  ],
  [
    "Empty — replies, reasoning, and tool calls will all appear here in chronological order once the team runs.",
    "空——一旦团队运行，这里将按时间顺序显示所有回复、推理和工具调用。",
    "비어 있음 — 팀이 실행하면 응답, 추론 및 도구 호출이 모두 여기에 시간순으로 나타납니다.",
    "空 — チームが実行すると、返信、推論、ツール呼び出しが時系列でここにすべて表示されます。",
    "فارغ — الردود، والتفكير، واستدعاءات الأدوات ستظهر هنا بالترتيب الزمني بمجرد أن يقوم الفريق بالتشغيل.",
    "Vuoto — risposte, ragionamenti e chiamate agli strumenti appariranno qui in ordine cronologico una volta eseguito dal team."
  ],
  [
    "empty = unsigned",
    "empty = 未签名",
    "비어 있음 = 서명되지 않음",
    "空 = 未署名",
    "فارغ = غير موقع",
    "vuoto = non firmato"
  ],
  [
    "Emulate this device: real viewport size + mobile user-agent (page reloads)",
    "模拟此设备：真实视口大小 + 移动用户代理（页面重载）",
    "이 장치 에뮬레이션: 실제 뷰포트 크기 + 모바일 사용자 에이전트 (페이지 새로고침)",
    "このデバイスをエミュレート: 実際のビューポートサイズ + モバイルユーザーエージェント（ページリロード）",
    "قم بمحاكاة هذا الجهاز: حجم عرض حقيقي + وكيل مستخدم للجوال (إعادة تحميل الصفحة)",
    "Emula questo dispositivo: dimensioni reali della finestra + user-agent mobile (ricarica pagina)"
  ],
  [
    "emulated USB-HID keyboard), 'keys' (press a key chord/sequence, e.g. 'ctrl+alt+del' or",
    "模拟的 USB-HID 键盘）、'keys'（按按键组合/序列，例如 'ctrl+alt+del' 或",
    "에뮬레이션된 USB-HID 키보드), '키' (키 조합/시퀀스 누르기, 예: 'ctrl+alt+del' 또는",
    "エミュレートされた USB-HID キーボード）、'keys'（キーの組み合わせ/シーケンスを押す、例: 'ctrl+alt+del' または",
    "لوحة مفاتيح USB-HID محاكاة)، 'المفاتيح' (اضغط على تركيبة/تسلسل مفتاح، على سبيل المثال 'ctrl+alt+del' أو",
    "tastiera USB-HID emulata), 'tasti' (premere una combinazione/sequenza di tasti, es. 'ctrl+alt+del' o"
  ],
  [
    "Enable the",
    "启用",
    "활성화",
    "有効にする",
    "تمكين",
    "Abilita il"
  ],
  [
    "Enable tool calls in Agent mode",
    "在代理模式下启用工具调用",
    "에이전트 모드에서 도구 호출 활성화",
    "エージェントモードでのツール呼び出しを有効にする",
    "تمكين استدعاءات الأدوات في وضع الوكيل",
    "Abilita chiamate agli strumenti in modalità Agente"
  ],
  [
    "enabled",
    "已启用",
    "활성화됨",
    "有効化済み",
    "مفعل",
    "Abilitato"
  ],
  [
    "Enabled",
    "已启用",
    "활성화됨",
    "有効",
    "مُمكّن",
    "Abilitato"
  ],
  [
    "Enabled — advertised to agents",
    "已启用 — 向代理广告",
    "활성화됨 — 에이전트에게 광고됨",
    "有効 — エージェントに広告済み",
    "مفعل — معلن للوكلاء",
    "Abilitato — pubblicizzato agli agenti"
  ],
  [
    "encrypted",
    "加密",
    "암호화됨",
    "暗号化  ",
    "مشفر",
    "cifrato"
  ],
  [
    "Enter a generic idea first (one or two sentences is enough).",
    "首先输入一个通用想法（一句或两句话就够）。",
    "먼저 일반적인 아이디어를 입력하세요(한두 문장면 충분합니다).",
    "まず一般的なアイデアを入力してください（1、2文で十分です）。  ",
    "أدخل فكرة عامة أولاً (جملة أو جملتان كافيتان).",
    "Inserisci prima un'idea generica (una o due frasi sono sufficienti)."
  ],
  [
    "Enter system instructions...",
    "输入系统指令...",
    "시스템 지침 입력...",
    "システム指示を入力してください…  ",
    "أدخل تعليمات النظام...",
    "Inserisci le istruzioni del sistema..."
  ],
  [
    "Entire Screen",
    "整个屏幕",
    "전체 화면",
    "全画面  ",
    "الشاشة بالكامل",
    "Schermo intero"
  ],
  [
    "entr",
    "入口",
    "입력",
    "入力  ",
    "entr",
    "entr"
  ],
  [
    "Entry",
    "条目",
    "항목",
    "エントリー  ",
    "إدخال",
    "Voce"
  ],
  [
    "Environment",
    "环境",
    "환경",
    "環境  ",
    "البيئة",
    "Ambiente"
  ],
  [
    "Environment Variables (JSON):",
    "环境变量（JSON）：",
    "환경 변수(JSON):",
    "環境変数（JSON）：  ",
    "متغيرات البيئة (JSON):",
    "Variabili d'ambiente (JSON):"
  ],
  [
    "equipped",
    "配备",
    "장착됨",
    "装備済み  ",
    "مجهز",
    "equipaggiato"
  ],
  [
    "equipped skill context",
    "已配备技能上下文",
    "장착된 스킬 컨텍스트",
    "装備済みスキルコンテキスト  ",
    "سياق المهارة المجهزة",
    "contesto delle abilità equipaggiate"
  ],
  [
    "error",
    "错误",
    "오류",
    "エラー  ",
    "خطأ",
    "Errore"
  ],
  [
    "Error",
    "错误",
    "오류",
    "エラー",
    "خطأ",
    "Errore"
  ],
  [
    "Error — {0}",
    "错误 — {0}",
    "오류 — {0}",
    "エラー — {0}",
    "خطأ — {0}",
    "Errore — {0}"
  ],
  [
    "Eval loss",
    "评估损失",
    "평가 손실",
    "評価損失  ",
    "خسارة التقييم",
    "Perdita di valutazione"
  ],
  [
    "every",
    "每个",
    "모든",
    "すべて",
    "كل",
    "otto"
  ],
  [
    "Every inference server running across the app. Useful when something is holding GPU memory you can't see.",
    "在应用程序中运行的每个推理服务器。当某些东西占用你看不见的 GPU 内存时很有用。",
    "앱 전반에서 실행 중인 모든 추론 서버. 볼 수 없는 GPU 메모리를 점유하고 있는 경우에 유용합니다.",
    "アプリ全体で実行されているすべての推論サーバー。自分で見えないGPUメモリを保持している何かがあるときに便利です。",
    "كل خادم استنتاج يعمل عبر التطبيق. مفيد عندما يكون هناك شيء يستهلك ذاكرة GPU ولا يمكنك رؤيته.",
    "Ogni server di inferenza in esecuzione nell'app. Utile quando qualcosa sta occupando memoria GPU che non puoi vedere."
  ],
  [
    "Every request, both sides, redacted (command output is never stored — only a length + digest).",
    "每个请求，双方，均已编辑（命令输出从不存储——只存储长度 + 摘要）。",
    "모든 요청, 양쪽 모두, 편집됨(명령 출력은 절대 저장되지 않음 — 길이와 다이제스트만 저장됨).",
    "すべてのリクエストは両方の側で編集済み（コマンド出力は保存されず、長さとダイジェストのみが記録されます）。",
    "كل طلب، من كلا الجانبين، مُحرَّف (مخرجات الأوامر لا تُخزن أبدًا — فقط الطول + الملخص).",
    "Ogni richiesta, entrambe le parti, oscurata (l'output dei comandi non viene mai memorizzato — solo una lunghezza + digest)."
  ],
  [
    "Everything a shipping developer juggles — certificates, signing selectors, portal logins, tokens — managed in one place, kept encrypted on this machine. Provider portals open inside OwLLM's own browser, already signed in from your saved logins, so \"renew the cert\" stops being an afternoon of password resets.",
    "开发人员处理的所有事务——证书、签名选择器、门户登录、令牌——都在一个地方管理，并在这台机器上保持加密。提供商门户在 OwLLM 自带的浏览器中打开，已经使用你保存的登录信息登录，因此“更新证书”不再是一个需要整下午重置密码的任务。",
    "배송 개발자가 다루는 모든 것 — 인증서, 서명 선택기, 포털 로그인, 토큰 — 한 곳에서 관리되며 이 기계에 암호화되어 저장됨. 공급자 포털은 OwLLM 자체 브라우저 안에서 열리며, 저장된 로그인으로 이미 로그인되어 있기 때문에 '인증서 갱신'이 오후 내내 비밀번호 재설정으로 시간을 보내는 일이 아님.",
    "配送開発者が扱うすべてのもの—証明書、署名セレクター、ポータルログイン、トークン—は1つの場所で管理され、このマシン上で暗号化されて保存されます。プロバイダーポータルはOwLLM自身のブラウザ内で開き、保存されたログイン情報からすでにサインインされているため、「証明書を更新する」作業が午後を費やすパスワードリセット作業から解放されます。",
    "كل ما يديره مطور الشحن — الشهادات، محددات التوقيع، تسجيلات الدخول للبوابات، الرموز — يُدار في مكان واحد، ويُحتفظ به مشفرًا على هذا الجهاز. تفتح بوابات المزود داخل متصفح OwLLM الخاص، مُسجّل الدخول بالفعل من حساباتك المحفوظة، لذا فإن \"تجديد الشهادة\" يتوقف عن كونها فترة بعد ظهر من إعادة ضبط كلمات المرور.",
    "Tutto ciò che un sviluppatore di spedizioni gestisce — certificati, selettori di firma, accessi ai portali, token — gestito in un unico posto, mantenuto criptato su questa macchina. I portali dei provider si aprono all'interno del browser di OwLLM, già autenticati con i tuoi accessi salvati, così \"rinnovare il certificato\" smette di essere un pomeriggio di reset di password."
  ],
  [
    "exa_…",
    "exa_…",
    "exa_…",
    "exa_…",
    "exa_…",
    "exa_…"
  ],
  [
    "Exact text to find and replace.",
    "精确的文本查找和替换。",
    "찾아 바꿀 정확한 텍스트.",
    "見つけて置き換える正確なテキスト。",
    "النص الدقيق للعثور عليه واستبداله.",
    "Testo esatto da trovare e sostituire."
  ],
  [
    "example templates for specialized connectors",
    "专用连接器的示例模板",
    "특화된 커넥터를 위한 예제 템플릿",
    "専門コネクタ用の例テンプレート",
    "نماذج مثال للموصلات المتخصصة",
    "Esempi di template per connettori specializzati"
  ],
  [
    "Examples / needs connectors",
    "示例 / 需要连接器",
    "예제 / 커넥터 필요",
    "例 / コネクタが必要",
    "أمثلة / الحاجة إلى الموصلات",
    "Esempi / hanno bisogno di connettori"
  ],
  [
    "Examples:",
    "示例：",
    "예시:",
    "例：",
    "أمثلة:",
    "Esempi:"
  ],
  [
    "Expired {0}",
    "已过期 {0}",
    "{0} 만료됨",
    "期限切れ {0}",
    "منتهية الصلاحية {0}",
    "Scaduto {0}"
  ],
  [
    "Expires {0} · {1}d",
    "将在 {0} · {1}天 后过期",
    "{0} 만료 · {1}일",
    "有効期限 {0} · {1}日",
    "تنتهي صلاحيتها {0} · {1}ي",
    "Scade {0} · {1}g"
  ],
  [
    "expiry, which fields are present) by default. Pass include_secrets=true to also get the CI env",
    "到期，默认为哪些字段存在）。传递 include_secrets=true 以同时获取 CI 环境",
    "만료, 기본적으로 어떤 필드가 있는지). include_secrets=true를 전달하면 CI 환경도 가져옵니다.",
    "有効期限、どのフィールドが存在するか）デフォルトで。CI環境も取得するには include_secrets=true を渡してください。",
    "الانتهاء، الحقول الموجودة) بشكل افتراضي. مرر include_secrets=true للحصول أيضًا على بيئة CI",
    "scadenza, quali campi sono presenti) per impostazione predefinita. Passa include_secrets=true per ottenere anche l'ambiente CI"
  ],
  [
    "Explore Models",
    "探索模型",
    "모델 탐색",
    "モデルを探る",
    "استكشاف النماذج",
    "Esplora Modelli"
  ],
  [
    "Extra env vars (JSON, optional):",
    "额外的环境变量（JSON，可选）：",
    "추가 환경 변수 (JSON, 선택 사항):",
    "追加の環境変数（JSON、任意）：",
    "متغيرات بيئة إضافية (JSON، اختياري):",
    "Variabili di ambiente extra (JSON, opzionale):"
  ],
  [
    "Extra env vars must be valid JSON.",
    "额外的环境变量必须是有效的 JSON。",
    "추가 환경 변수는 유효한 JSON이어야 합니다.",
    "追加の環境変数は有効なJSONである必要があります。",
    "يجب أن تكون متغيرات البيئة الإضافية JSON صالح.",
    "Le variabili di ambiente extra devono essere JSON valido."
  ],
  [
    "Extra instructions (appended to role prompt)",
    "额外指令（附加到角色提示）",
    "추가 지침 (역할 프롬프트에 추가됨)",
    "追加の指示（ロールプロンプトに追加）",
    "تعليمات إضافية (تضاف إلى مطالبة الدور)",
    "Istruzioni extra (aggiunte al prompt del ruolo)"
  ],
  [
    "Extra instructions layered on top of this agent's base role prompt at dispatch…",
    "在派遣时在该代理的基本角色提示上叠加的额外指令…",
    "이 에이전트의 기본 역할 프롬프트 위에 추가 지침을 겹쳐서 적용 중…",
    "このエージェントの基本役割プロンプトに追加された追加指示…",
    "تعليمات إضافية مضافة فوق دور هذا الوكيل الأساسي عند الإرسال…",
    "Istruzioni extra sovrapposte al prompt di ruolo base di questo agente al momento dell'invio…"
  ],
  [
    "Extra prompt (optional — appended to the base role's prompt)",
    "额外提示（可选 — 添加到基本角色提示后）",
    "추가 프롬프트(선택 사항 — 기본 역할 프롬프트에 덧붙임)",
    "追加プロンプト（オプション — 基本役割のプロンプトに追加）",
    "مطالبة إضافية (اختياري — مضافة إلى مطالبة الدور الأساسية)",
    "Prompt extra (opzionale — aggiunto al prompt del ruolo base)"
  ],
  [
    "Extracting text from {0} source(s)…",
    "正在从 {0} 个来源提取文本…",
    "{0} 출처에서 텍스트 추출 중…",
    "{0} のソースからテキストを抽出中…",
    "استخراج النص من {0} مصدر/مصادر…",
    "Estrazione del testo da {0} sorgente(i)…"
  ],
  [
    "Extraction + generation progress appears here.",
    "提取 + 生成进度显示在此处。",
    "추출 + 생성 진행 상황이 여기에 표시됩니다.",
    "抽出+生成の進行状況はここに表示されます。",
    "يظهر هنا تقدم الاستخراج + التوليد.",
    "Qui appare il progresso di estrazione + generazione."
  ],
  [
    "Extracts last-token hidden states at every layer; finds the strongest activation-difference direction at the best layer (the \"refusal direction\").",
    "在每一层提取最后一个标记的隐藏状态；在最佳层找到最强的激活差异方向（“拒绝方向”）。",
    "모든 레이어에서 마지막 토큰 히든 상태를 추출합니다; 최고 레이어에서 가장 강한 활성 차이 방향을 찾습니다(\"거부 방향\").",
    "各レイヤーで最後のトークンの隠れ状態を抽出する; 最も強い活性化差の方向を最適なレイヤーで見つける（「拒否方向」）。",
    "يستخرج الحالات المخفية للرمز الأخير في كل طبقة؛ يجد اتجاه الفرق في التنشيط الأقوى في أفضل طبقة (اتجاه \"الرفض\").",
    "Estrae gli stati nascosti dell'ultimo token a ogni livello; trova la direzione di differenza di attivazione più forte al miglior livello (la \"direzione di rifiuto\")."
  ],
  [
    "F16",
    "F16",
    "F16",
    "F16",
    "F16",
    "F16"
  ],
  [
    "F2",
    "F2",
    "F2",
    "F2",
    "F2",
    "F2"
  ],
  [
    "F32",
    "F32",
    "F32",
    "F32",
    "F32",
    "F32"
  ],
  [
    "fact (colored by tag)",
    "事实（按标签着色）",
    "태그로 색칠된 사실",
    "事実（タグで色分けされる）",
    "حقيقة (ملونة حسب الوسم)",
    "fatto (colorato per tag)"
  ],
  [
    "fact in place (e.g. key='build_command') instead of duplicating it.",
    "原位事实（例如 key='build_command'）而不是复制它。",
    "복제하지 않고 제자리에서 사실 사용(예: key='build_command')",
    "事実をその場で（例: key='build_command'）、複製せずに使用する。",
    "حقيقة في مكانها (مثل key='build_command') بدلاً من تكرارها.",
    "fatto al posto (ad es. key='build_command') invece di duplicarlo."
  ],
  [
    "facts",
    "事实",
    "사실",
    "事実",
    "حقائق",
    "fatti"
  ],
  [
    "Failed",
    "失败",
    "실패",
    "失敗",
    "فشل",
    "Fallito"
  ],
  [
    "Failed to list sources: {0}",
    "无法列出来源：{0}",
    "출처를 나열하지 못했습니다: {0}",
    "ソースの一覧化に失敗しました: {0}",
    "فشل في سرد المصادر: {0}",
    "Impossibile elencare le fonti: {0}"
  ],
  [
    "Failed: {0}",
    "失败：{0}",
    "실패: {0}",
    "失敗: {0}",
    "فشل: {0}",
    "Fallito: {0}"
  ],
  [
    "FailSpy's refusal-direction stripping recipe",
    "FailSpy 的拒绝方向剥离方法",
    "FailSpy의 거부 방향 제거 레시피",
    "FailSpyの拒否方向除去レシピ",
    "وصفة FailSpy لإزالة اتجاه الرفض",
    "Ricetta di rimozione della direzione di rifiuto di FailSpy"
  ],
  [
    "Fast-forward {0} to HEAD on origin",
    "快速前进 {0} 到 origin 的 HEAD",
    "{0}를 origin의 HEAD로 패스트포워드",
    "{0}をHEADに向けてoriginで早送り",
    "الإسراع {0} إلى HEAD على الأصل",
    "Avanzamento rapido {0} a HEAD su origin"
  ],
  [
    "fed to team",
    "交给团队",
    "팀에 제공됨",
    "チームに提供済み",
    "تم تغذيته للفريق",
    "inviato al team"
  ],
  [
    "Feed now — dispatches this step as a new goal",
    "立即提供——将此步骤作为新目标发送",
    "지금 피드 — 이 단계를 새로운 목표로 발송",
    "今すぐフィード — このステップを新しい目標として送信",
    "أطعم الآن — أرسل هذه الخطوة كهدف جديد",
    "Nutri ora — invia questo passaggio come un nuovo obiettivo"
  ],
  [
    "Feed now — steers the running team at its next boundary",
    "立即喂入——在下一边界引导运行团队",
    "지금 피드 — 다음 경계에서 실행 팀을 조종합니다.",
    "今すぐフィード — 次の境界で実行中のチームを誘導します",
    "أطعم الآن — يوجّه فريق التشغيل عند حدّه التالي.",
    "Alimenta ora — dirige il team in esecuzione al suo prossimo confine"
  ],
  [
    "Feed the first pending step now — auto-feed walks the rest of the list, one step per clean run",
    "立即喂入第一个待处理步骤——自动喂入会按一次干净运行走完列表的其余步骤",
    "첫 번째 대기 단계를 지금 피드 — 자동 피드는 나머지 목록을 깨끗하게 한 단계씩 실행합니다.",
    "最初の保留中のステップを今すぐフィード — 自動フィードが残りのリストを一つのクリーンランごとに実行します",
    "أطعم الخطوة المعلقة الأولى الآن — التغذية التلقائية تحرك بقية القائمة، خطوة واحدة لكل تشغيل نظيف.",
    "Alimenta il primo passo in sospeso ora — l'auto-alimentazione percorre il resto della lista, un passo per ogni corsa pulita"
  ],
  [
    "Feed the first pending step now (turn on auto-feed to walk the whole list automatically)",
    "立即喂入第一个待处理步骤（开启自动喂入以自动完成整个列表）",
    "지금 첫 번째 대기 단계를 피드(전체 목록을 자동으로 걷도록 자동 피드를 켭니다)",
    "  \n最初の保留中ステップを今すぐフィード（オートフィードをオンにするとリスト全体を自動で進める）  ",
    "غذِّ الخطوة المعلقة الأولى الآن (قم بتشغيل التغذية التلقائية للمرور على القائمة بأكملها تلقائياً)",
    "Alimenta il primo passo in sospeso ora (attiva l'alimentazione automatica per percorrere automaticamente tutta la lista)"
  ],
  [
    "Feed the whole NOW batch — steers the running team at its next boundary. The board keeps its cards.",
    "喂入整个 NOW 批次——在下一边界引导运行团队。板子保留其卡片。",
    "전체 NOW 배치를 피드 — 다음 경계에서 실행 팀을 조종합니다. 보드는 카드를 유지합니다.",
    "今すぐバッチ全体をフィード — 次の境界で実行中のチームを誘導します。ボードはカードを保持します。",
    "أطعم دفعة الآن كاملة — يوجّه فريق التشغيل عند حدّه التالي. اللوحة تحتفظ ببطاقاتها.",
    "Alimenta l'intero batch ORA — dirige il team in esecuzione al suo prossimo confine. La scheda mantiene le sue carte."
  ],
  [
    "Fetch / refresh",
    "获取 / 刷新",
    "가져오기 / 새로 고침",
    "  \n取得 / 更新  ",
    "جلب / تحديث",
    "Recupera / aggiorna"
  ],
  [
    "Fetch a URL → return as markdown. Simpler than puppeteer for static pages.",
    "获取 URL → 以 Markdown 返回。比 Puppeteer 处理静态页面更简单。",
    "URL 가져오기 → 마크다운으로 반환. 정적 페이지에서는 puppeteer보다 간단합니다.",
    "URLを取得 → マークダウンとして返します。静的ページにはpuppeteerより簡単です。",
    "استرجع عنوان URL → أعده على شكل ماركداون. أبسط من Puppeteer للصفحات الثابتة.",
    "Recupera un URL → restituisci come markdown. Più semplice di puppeteer per pagine statiche."
  ],
  [
    "Fetch a URL and return its readable text (HTML stripped,",
    "获取 URL 并返回其可读文本（HTML 已剥离）",
    "URL을 가져와 읽을 수 있는 텍스트로 반환 (HTML 제거,",
    "  \nURLを取得して可読テキストを返す（HTML除去  ",
    "جلب عنوان ويب وإرجاع نصه القابل للقراءة (تمت إزالة HTML،",
    "Recupera un URL e restituisci il suo testo leggibile (HTML rimosso,"
  ],
  [
    "Fetching {0}…",
    "正在获取 {0}…",
    "{0} 가져오는 중…",
    "{0} を取得中…",
    "جارٍ استرجاع {0}…",
    "Recupero {0}…"
  ],
  [
    "file content (written on the target only after it approves the action)",
    "文件内容（仅在目标批准操作后写入）",
    "파일 내용 (작업 승인 후 대상에만 작성됨)",
    "  \nファイル内容（アクションが承認された後にターゲットに書き込まれる）",
    "محتوى الملف (يُكتب على الهدف فقط بعد الموافقة على الإجراء)",
    "contenuto del file (scritto sul target solo dopo l'approvazione dell'azione)"
  ],
  [
    "File write ⚠ (approval)",
    "文件写入 ⚠（批准）",
    "파일 쓰기 ⚠ (승인 필요)",
    "ファイル書き込み ⚠ （承認）",
    "كتابة الملف ⚠ (الموافقة)",
    "Scrittura file ⚠ (approvazione)"
  ],
  [
    "File write is a dangerous action — the target must approve it live (and its policy must allow file writes).",
    "文件写入是一个危险操作——目标必须实时批准（并且其策略必须允许文件写入）。",
    "파일 쓰기는 위험한 행동입니다 — 대상은 실시간으로 승인해야 하며(그리고 정책이 파일 쓰기를 허용해야 함).",
    "ファイル書き込みは危険な操作です — 対象はリアルタイムでこれを承認する必要があります（そしてそのポリシーがファイル書き込みを許可している必要があります）。",
    "كتابة الملف هي إجراء خطير — يجب أن يوافق الهدف عليه مباشرة (ويجب أن تسمح سياسته بكتابة الملفات).",
    "La scrittura di file è un'azione pericolosa — il destinatario deve approvarla in tempo reale (e la sua politica deve consentire la scrittura di file)."
  ],
  [
    "File writes",
    "文件写入",
    "파일 쓰기",
    "ファイル書き込み",
    "كتابات الملفات",
    "Scritture di file"
  ],
  [
    "file. Upload that file at Apple's \"Create a certificate\" page, download the issued",
    "文件。将该文件上传到苹果的“创建证书”页面，下载颁发的",
    "파일. 해당 파일을 Apple의 '인증서 생성' 페이지에 업로드하고 발급된 파일을 다운로드하세요.",
    "ファイル。Appleの「証明書を作成」ページでそのファイルをアップロードし、発行されたものをダウンロードします。",
    "ملف. قم بتحميل ذلك الملف في صفحة \"إنشاء شهادة\" الخاصة بشركة Apple، وقم بتنزيل الشهادة الصادرة",
    "file. Carica quel file nella pagina \"Crea un certificato\" di Apple, scarica il certificato emesso"
  ],
  [
    "Filename glob filter, e.g. '*.rs' or '*.{ts,tsx}'.",
    "文件名通配符过滤，例如 '*.rs' 或 '*.{ts,tsx}'。",
    "파일 이름 글로브 필터, 예: '*.rs' 또는 '*.{ts,tsx}'.",
    "ファイル名のグロブフィルター、例：'*.rs' または '*.{ts,tsx}'。",
    "مرشح أسماء الملفات باستخدام glob، على سبيل المثال '*.rs' أو '*.{ts,tsx}'.",
    "Filtro glob per nome file, ad esempio '*.rs' o '*.{ts,tsx}'."
  ],
  [
    "files",
    "文件",
    "파일들",
    "ファイル",
    "ملفات",
    "file"
  ],
  [
    "files — recommended.",
    "文件 —— 推荐。",
    "파일 — 권장됨.",
    "ファイル — 推奨。",
    "الملفات — موصى بها.",
    "file — consigliati."
  ],
  [
    "filesystem. If your model also offers the memory_search / memory_read tools, use",
    "文件系统。如果您的模型还提供 memory_search / memory_read 工具，请使用",
    "파일시스템. 모델이 memory_search / memory_read 도구도 제공하는 경우 사용하십시오",
    "ファイルシステム。もしあなたのモデルが memory_search / memory_read ツールも提供している場合は、使用してください。",
    "نظام الملفات. إذا كان نموذجك يقدم أيضًا أدوات memory_search / memory_read، استخدمها.",
    "sistema di file. Se il tuo modello offre anche gli strumenti memory_search / memory_read, usali"
  ],
  [
    "Fill this page's login from your saved passwords",
    "从已保存的密码填写此页面的登录信息",
    "저장된 비밀번호로 이 페이지의 로그인 정보를 채우십시오.",
    "このページのログイン情報を保存したパスワードから入力",
    "املأ تسجيل الدخول في هذه الصفحة من كلمات المرور المحفوظة لديك",
    "Compila il login di questa pagina dai tuoi password salvati"
  ],
  [
    "Filter agents…",
    "筛选代理…",
    "에이전트 필터...",
    "エージェントをフィルタ…",
    "تصفية الوكلاء…",
    "Filtra agenti…"
  ],
  [
    "Filter log…",
    "筛选日志…",
    "로그 필터...",
    "ログをフィルタ…",
    "تصفية السجل…",
    "Filtra log…"
  ],
  [
    "Filter skills…",
    "筛选技能…",
    "기술 필터...",
    "スキルをフィルタ…",
    "تصفية المهارات…",
    "Filtra competenze…"
  ],
  [
    "Filter teams by name, description, category, or agent…",
    "按名称、描述、类别或代理筛选团队…",
    "이름, 설명, 카테고리 또는 에이전트별로 팀 필터링…",
    "チームを名前、説明、カテゴリ、またはエージェントでフィルタリング…",
    "تصفية الفرق بالاسم أو الوصف أو الفئة أو الوكيل…",
    "Filtra i team per nome, descrizione, categoria o agente…"
  ],
  [
    "filter…",
    "筛选…",
    "필터…",
    "フィルタ…",
    "تصفية…",
    "Filtra…"
  ],
  [
    "Filter…",
    "过滤…",
    "필터…",
    "フィルター…",
    "تصفية…",
    "Filtro…"
  ],
  [
    "Find",
    "查找",
    "찾기",
    "検索",
    "بحث",
    "Trova"
  ],
  [
    "Find files by filename pattern. Walks the tree under `path`",
    "按文件名模式查找文件。遍历 `path` 下的目录树",
    "파일 이름 패턴으로 파일 찾기. `path` 아래 트리를 탐색합니다",
    "ファイル名パターンでファイルを検索します。`path` 以下のツリーを走査します",
    "البحث عن الملفات حسب نمط اسم الملف. يتجول في الشجرة تحت `path`",
    "Trova file per modello di nome. Esplora l'albero sotto `path`"
  ],
  [
    "findings). It persists across agents AND across future runs of this project.",
    "发现)。它在代理之间以及该项目的未来运行中持续存在。",
    "결과). 이는 에이전트 전반과 이 프로젝트의 향후 실행에서도 지속됩니다.",
    "所見）。これはエージェント間およびこのプロジェクトの将来の実行にわたって持続します。",
    "النتائج). يستمر هذا عبر الوكلاء وعبر تشغيلات هذا المشروع المستقبلية.",
    "risultati). Persiste tra gli agenti E tra le future esecuzioni di questo progetto."
  ],
  [
    "Fine Tune",
    "微调",
    "파인 튜닝",
    "ファインチューニング",
    "ضبط دقيق",
    "Ottimizza"
  ],
  [
    "Fine Tuning",
    "微调中",
    "파인 튜닝 중",
    "ファインチューニング中",
    "الضبط الدقيق",
    "Ottimizzazione"
  ],
  [
    "Fine-tuned outputs",
    "微调输出",
    "파인 튜닝된 출력",
    "ファインチューニング済み出力",
    "المخرجات المضبوطة بدقة",
    "Risultati ottimizzati"
  ],
  [
    "Fine-tuning environments — install / check what's ready",
    "微调环境 — 安装 / 检查准备情况",
    "파인튜닝 환경 — 설치 / 준비 상태 확인",
    "ファインチューニング環境 — インストール / 準備状況の確認",
    "بيئات الضبط الدقيق — تثبيت / التحقق مما هو جاهز",
    "Ambienti di fine-tuning — installa / controlla cosa è pronto"
  ],
  [
    "Finish WSL setup before installing an environment.",
    "在安装环境之前完成 WSL 设置。",
    "환경 설치 전에 WSL 설정을 완료하세요.",
    "環境をインストールする前に WSL のセットアップを完了してください。",
    "أكمل إعداد WSL قبل تثبيت البيئة.",
    "Completa la configurazione di WSL prima di installare un ambiente."
  ],
  [
    "Finished → {0}",
    "完成 → {0}",
    "완료 → {0}",
    "完了 → {0}",
    "تم الانتهاء → {0}",
    "Finito → {0}"
  ],
  [
    "first agent run",
    "首次代理运行",
    "첫 번째 에이전트 실행",
    "最初のエージェント実行",
    "تشغيل الوكيل الأول",
    "prima esecuzione dell'agente"
  ],
  [
    "First click loads the local model, then auto-sends. Subsequent clicks send immediately.",
    "首次点击加载本地模型，然后自动发送。后续点击会立即发送。",
    "첫 클릭은 로컬 모델을 로드한 후 자동으로 전송합니다. 다음 클릭은 즉시 전송합니다.",
    "最初のクリックでローカルモデルをロードし、次に自動送信します。以降のクリックはすぐに送信します。",
    "النقرة الأولى تُحمّل النموذج المحلي، ثم ترسل تلقائيًا. النقرات التالية ترسل على الفور.",
    "Il primo clic carica il modello locale, poi invia automaticamente. I clic successivi inviano immediatamente."
  ],
  [
    "first to make your own copy.",
    "首先制作你自己的副本。",
    "먼저 자신의 사본을 만드세요.",
    "まず自分のコピーを作成します。",
    "أول من يصنع نسخة خاصة بك.",
    "per primo per fare la tua copia."
  ],
  [
    "first-run",
    "首次运行",
    "첫 실행",
    "初回実行",
    "التشغيل الأول",
    "prima esecuzione"
  ],
  [
    "Fits comfortably (inference + fine-tuning)",
    "舒适适配（推理 + 微调）",
    "편안하게 맞습니다 (추론 + 미세 조정)",
    "快適にフィットする（推論 + ファインチューニング）",
    "يتناسب بشكل مريح (الاستنتاج + الضبط الدقيق)",
    "Si adatta comodamente (inferenza + fine-tuning)"
  ],
  [
    "Fits your VRAM",
    "适合你的显存",
    "VRAM에 맞습니다",
    "VRAM にフィットする",
    "يتناسب مع VRAM الخاص بك",
    "Si adatta alla tua VRAM"
  ],
  [
    "Fix bugs",
    "修复漏洞",
    "버그 수정",
    "バグを修正する",
    "إصلاح الأخطاء",
    "Correggi bug"
  ],
  [
    "Fix WSL on the Home page or convert the project into the sandbox.",
    "修复主页上的 WSL 或将项目转换为沙箱。",
    "홈 페이지에서 WSL을 수정하거나 프로젝트를 샌드박스로 변환합니다.",
    "ホームページの WSL を修正するか、プロジェクトをサンドボックスに変換する。",
    "إصلاح WSL في الصفحة الرئيسية أو تحويل المشروع إلى البيئة التجريبية.",
    "Correggi WSL nella pagina principale o converti il progetto nella sandbox."
  ],
  [
    "Folder",
    "文件夹",
    "폴더",
    "フォルダ",
    "مجلد",
    "Cartella"
  ],
  [
    "Folder / location",
    "文件夹 / 位置",
    "폴더 / 위치",
    "フォルダ / 場所",
    "المجلد / الموقع",
    "Cartella / posizione"
  ],
  [
    "Folder pick failed: {0}",
    "文件夹选择失败: {0}",
    "폴더 선택 실패: {0}",
    "フォルダ選択に失敗しました: {0}",
    "فشل اختيار المجلد: {0}",
    "Selezione della cartella non riuscita: {0}"
  ],
  [
    "Folder picker failed: {0}",
    "文件夹选择器失败: {0}",
    "폴더 선택기 실패: {0}",
    "フォルダピッカーに失敗しました: {0}",
    "فشل أداة اختيار المجلد: {0}",
    "Selettore cartella non riuscito: {0}"
  ],
  [
    "follow the OAuth URL that appears.",
    "跟随出现的 OAuth URL。",
    "표시되는 OAuth URL을 따르세요.",
    "表示されるOAuth URLに従ってください。",
    "اتبع رابط OAuth الذي يظهر.",
    "segui l'URL OAuth che appare."
  ],
  [
    "for a safe rehearsal (build+sign, no publish). Publisher role only.",
    "用于安全排练（构建+签名，不发布）。仅限发布者角色。",
    "안전한 리허설을 위해 (빌드+서명, 게시 없음). 게시자 역할만.",
    "安全なリハーサル用（ビルド + 署名、公開なし）。発行者ロールのみ。",
    "لبروفة آمنة (بناء + توقيع، بدون نشر). دور الناشر فقط.",
    "per una prova sicura (build+firma, senza pubblicare). Solo ruolo Publisher."
  ],
  [
    "For security, agents are confined to the working folder",
    "为了安全，代理被限制在工作文件夹内",
    "보안을 위해 에이전트는 작업 폴더로 제한됩니다",
    "セキュリティのため、エージェントは作業フォルダに制限されます",
    "لأسباب أمنية، يتم حصر الوكلاء في مجلد العمل",
    "Per sicurezza, gli agenti sono confinati alla cartella di lavoro"
  ],
  [
    "for the brainstorm GUI-direction synthesis. Output PNG should",
    "用于头脑风暴 GUI 方向综合。输出 PNG 应该",
    "브레인스토밍 GUI-방향 합성을 위해. 출력 PNG는",
    "ブレインストーム GUI 方向の合成用。出力 PNG は",
    "لتوليف واجهة التفكير الإبداعي GUI. يجب أن يكون الإخراج بصيغة PNG",
    "per la sintesi della direzione GUI del brainstorming. L'output PNG dovrebbe"
  ],
  [
    "for this project",
    "针对本项目",
    "이 프로젝트를 위해",
    "このプロジェクト用",
    "لهذا المشروع",
    "per questo progetto"
  ],
  [
    "Force re-clone",
    "强制重新克隆",
    "강제로 다시 클론",
    "強制的に再クローンする",
    "إجبار إعادة الاستنساخ",
    "Forza il nuovo clone"
  ],
  [
    "Force this agent to a specific model id (e.g. 'claude-opus-4-7', 'claude-sonnet-4-6', 'gpt-5'). Leave empty to inherit from the team default → server fallback. Useful for pinning a critic to a cheap fast model while the orchestrator runs on Opus.",
    "将此代理强制设置为特定的模型 ID（例如 'claude-opus-4-7'、'claude-sonnet-4-6'、'gpt-5'）。留空则继承团队默认 → 服务器回退。对于在编排器运行在 Opus 时，将评论者固定在廉价快速模型上非常有用。",
    "이 에이전트를 특정 모델 ID(예: 'claude-opus-4-7', 'claude-sonnet-4-6', 'gpt-5')로 강제로 설정합니다. 팀 기본값에서 상속하려면 비워 두십시오 → 서버 대체. 오케스트레이터가 Opus에서 실행되는 동안 크리틱을 저렴하고 빠른 모델에 고정할 때 유용합니다. ",
    "このエージェントを特定のモデルID（例：'claude-opus-4-7', 'claude-sonnet-4-6', 'gpt-5'）に強制します。空欄にするとチームのデフォルト → サーバーフォールバックを継承します。オーケストレーターがOpusで実行されている間に、批評者を安くて高速なモデルに固定する際に便利です。",
    "إجبار هذا الوكيل على استخدام معرف نموذج محدد (مثل 'claude-opus-4-7'، 'claude-sonnet-4-6'، 'gpt-5'). اتركه فارغًا للاعتماد على الإعداد الافتراضي للفريق → الرجوع إلى الخادم. مفيد لتثبيت ناقد على نموذج رخيص وسريع بينما يعمل المنسق على Opus.",
    "Forza questo agente a un id modello specifico (ad esempio 'claude-opus-4-7', 'claude-sonnet-4-6', 'gpt-5'). Lascia vuoto per ereditare dal default del team → fallback del server. Utile per assegnare un critico a un modello economico e veloce mentre l'orchestratore gira su Opus."
  ],
  [
    "Forced on by OWLLM_REMOTE_DEVICES.",
    "由 OWLLM_REMOTE_DEVICES 强制开启。",
    "OWLLM_REMOTE_DEVICES에 의해 강제로 적용됨.",
    "OWLLM_REMOTE_DEVICESによって強制されます。",
    "تم فرضه بواسطة OWLLM_REMOTE_DEVICES.",
    "Forzato da OWLLM_REMOTE_DEVICES."
  ],
  [
    "Forced on by the OWLLM_KVM_NODE environment variable — the toggle is bypassed.",
    "由 OWLLM_KVM_NODE 环境变量强制启用——此开关将被绕过。",
    " OWLLM_KVM_NODE 환경 변수에 의해 강제로 적용됨 — 토글은 우회됩니다.",
    "OWLLM_KVM_NODE環境変数によって強制されます — トグルはバイパスされます。",
    "يتم فرضه بواسطة متغير البيئة OWLLM_KVM_NODE — يتم تجاوز التبديل.",
    "Forzato dalla variabile d'ambiente OWLLM_KVM_NODE — l'interruttore viene bypassato."
  ],
  [
    "forget",
    "忘记",
    "잊기",
    "忘れる",
    "انسَ",
    "dice"
  ],
  [
    "Fork this team into a new, separately-named template (keeps the original untouched)",
    "将此团队分叉为一个新的、单独命名的模板（保持原始不变）",
    "이 팀을 새로 이름이 지정된 템플릿으로 포크합니다(원본은 그대로 유지됨)",
    "このチームを新しく別名のテンプレートにフォークする（元のものはそのまま残す）",
    "افرع هذا الفريق إلى نموذج جديد باسم منفصل (يحافظ على النسخة الأصلية دون تغيير)",
    "Dividi questo team in un nuovo modello separatamente nominato (mantiene l'originale intatto)"
  ],
  [
    "form",
    "表单",
    "형식",
    "フォーム",
    "نموذج",
    "Modulo"
  ],
  [
    "Forward this reply to the primary agent",
    "将此回复转发给主代理",
    "이 답변을 기본 에이전트로 전달합니다",
    "この返信をプライマリエージェントに転送する",
    "أرسل هذه الإجابة إلى العميل الرئيسي",
    "Inoltra questa risposta all'agente principale"
  ],
  [
    "Forward this reply to the second agent",
    "将此回复转发给第二代理",
    "이 답변을 두 번째 에이전트로 전달합니다",
    "この返信をセカンドエージェントに転送する",
    "أرسل هذه الإجابة إلى العميل الثاني",
    "Inoltra questa risposta al secondo agente"
  ],
  [
    "Found {0} skills.",
    "找到 {0} 个技能。",
    "{0}개의 기술을 찾았습니다.",
    "{0} 件のスキルが見つかりました。",
    "تم العثور على {0} مهارات.",
    "Trovate {0} competenze."
  ],
  [
    "freed",
    "释放",
    "해방됨",
    "解放された",
    "حرر",
    "liberato"
  ],
  [
    "Full accent color palette",
    "完整的强调色调调色板",
    "전체 강조 색상 팔레트",
    "フルアクセントカラーパレット",
    "لوحة ألوان كاملة للنبرة",
    "Palette di colori completo dell'accento"
  ],
  [
    "Full agentic team — the orchestrator dispatches specialists",
    "完整的代理团队 — 指挥者派遣专家",
    "완전한 대리 팀 — 기획자가 전문가를 파견함",
    "完全なエージェンシーチーム — オーケストレーターが専門家を派遣する",
    "فريق وكالتي كامل — المنسق يرسل المتخصصين",
    "Team completamente agentico — l'orchestratore invia specialisti"
  ],
  [
    "Gamify",
    "游戏化",
    "게임화",
    "ゲーミファイ",
    "لعب",
    "Gamifica"
  ],
  [
    "Gateway not connected.",
    "网关未连接。",
    "게이트웨이 연결되지 않음.",
    "ゲートウェイが接続されていません。",
    "البوابة غير متصلة.",
    "Gateway non connesso."
  ],
  [
    "GB RAM",
    "GB 内存",
    "GB RAM",
    "GB RAM",
    "ذاكرة وصول عشوائي جيجابايت",
    "RAM GB"
  ],
  [
    "GB RAM ·",
    "GB RAM ·",
    "GB RAM ·",
    "GB RAM ·",
    "جيجابايت رام ·",
    "GB RAM ·"
  ],
  [
    "GB VRAM · Red = won't load",
    "GB VRAM · 红色 = 无法加载",
    "GB VRAM · 빨강 = 로드되지 않음",
    "GB VRAM · 赤 = 読み込まない",
    "جيجابايت فيرام · الأحمر = لن يتم التحميل",
    "GB VRAM · Rosso = non si carica"
  ],
  [
    "GB)",
    "GB)",
    "GB)",
    "GB)",
    "جيجابايت)",
    "GB)"
  ],
  [
    "GEMINI",
    "双子座",
    "쌍둥이자리",
    "ジェミニ",
    "جيميني",
    "GEMINI"
  ],
  [
    "Gemma 3",
    "杰玛 3",
    "젬마 3",
    "ジェンマ 3",
    "جيما 3",
    "Gemma 3"
  ],
  [
    "General",
    "通用",
    "일반",
    "一般",
    "عام",
    "Generale"
  ],
  [
    "General (freeform)",
    "通用（自由形式）",
    "일반 (자유형)",
    "一般（自由形式）",
    "عام (حرّ)",
    "Generale (a forma libera)"
  ],
  [
    "Generate a fresh random auth token (overwrites the current one).",
    "生成一个新的随机认证令牌（将覆盖当前的令牌）。",
    "새로운 무작위 인증 토큰 생성 (현재 토큰 덮어쓰기)",
    "新しいランダムな認証トークンを生成する（現在のものを上書きする）。",
    "توليد رمز مصادقة عشوائي جديد (سيتم الكتابة فوق الرمز الحالي).",
    "Genera un nuovo token di autenticazione casuale (sovrascrive quello attuale)."
  ],
  [
    "Generate dataset",
    "生成数据集",
    "데이터셋 생성",
    "データセットを生成",
    "إنشاء مجموعة بيانات",
    "Genera dataset"
  ],
  [
    "Generate request",
    "生成请求",
    "요청 생성",
    "リクエストを生成",
    "إنشاء طلب",
    "Genera richiesta"
  ],
  [
    "Generated pairs",
    "生成的对",
    "생성된 쌍",
    "生成されたペア",
    "الأزواج المُنشأة",
    "Coppie generate"
  ],
  [
    "Generating pairs — chunk {0}/{1} · {2} pair(s) so far…",
    "生成配对 — 块 {0}/{1} · 目前 {2} 对…",
    "쌍 생성 중 — 청크 {0}/{1} · 지금까지 {2}쌍…",
    "ペアを生成中 — チャンク {0}/{1} · 現在までに {2} ペア…",
    "توليد الأزواج — الجزء {0}/{1} · {2} زوجًا حتى الآن…",
    "Generazione coppie — blocco {0}/{1} · {2} coppia(e) finora…"
  ],
  [
    "generating…",
    "正在生成…",
    "생성 중…",
    "生成中…",
    "جارٍ التوليد…",
    "generando…"
  ],
  [
    "GENERATION",
    "生成",
    "생성",
    "生成",
    "الإنشاء",
    "GENERAZIONE"
  ],
  [
    "Generic local model",
    "通用本地模型",
    "일반 로컬 모델",
    "汎用ローカルモデル",
    "نموذج محلي عام",
    "Modello locale generico"
  ],
  [
    "get fresh indexes before interacting, and again after the page changes.",
    "在交互前获取新的索引，并在页面更改后再次获取。",
    "상호작용하기 전에 최신 인덱스를 가져오고, 페이지가 변경된 후에도 다시 가져오세요.",
    "操作前とページ変更後に新しいインデックスを取得してください。",
    "احصل على فهارس جديدة قبل التفاعل، ومرة أخرى بعد تغيّر الصفحة.",
    "ottieni indici aggiornati prima di interagire, e di nuovo dopo che la pagina cambia."
  ],
  [
    "Get one — Apple ID portal",
    "获取一个 — Apple ID 门户",
    "하나 받기 — Apple ID 포털",
    "1つ取得 — Apple ID ポータル",
    "احصل على واحد — بوابة Apple ID",
    "Ottienine uno — Portale Apple ID"
  ],
  [
    "ggml-base.bin",
    "ggml-base.bin",
    "ggml-base.bin",
    "ggml-base.bin",
    "ggml-base.bin",
    "ggml-base.bin"
  ],
  [
    "GGUF",
    "GGUF",
    "GGUF",
    "GGUF",
    "GGUF",
    "GGUF"
  ],
  [
    "GGUF export log",
    "GGUF 导出日志",
    "GGUF 내보내기 로그",
    "GGUF エクスポートログ",
    "سجل تصدير GGUF",
    "Log di esportazione GGUF"
  ],
  [
    "GGUF export logs (",
    "GGUF 导出日志(",
    "GGUF 내보내기 로그 (",
    "GGUF エクスポートログ (",
    "سجلات تصدير GGUF (",
    "Log di esportazione GGUF ("
  ],
  [
    "GGUF export start failed: {0}",
    "GGUF 导出启动失败: {0}",
    "GGUF 내보내기 시작 실패: {0}",
    "GGUF エクスポート開始に失敗しました: {0}",
    "فشل بدء تصدير GGUF: {0}",
    "Avvio esportazione GGUF fallito: {0}"
  ],
  [
    "GGUF export: {0}",
    "GGUF 导出: {0}",
    "GGUF 내보내기: {0}",
    "GGUF エクスポート: {0}",
    "تصدير GGUF: {0}",
    "Esportazione GGUF: {0}"
  ],
  [
    "gh",
    "gh",
    "gh",
    "gh",
    "gh",
    "gh"
  ],
  [
    "gh auth",
    "gh 认证",
    "gh 인증",
    "gh 認証",
    "gh المصادقة",
    "gh auth"
  ],
  [
    "gh CLI missing",
    "gh CLI 丢失",
    "gh CLI 누락",
    "gh CLI が見つかりません",
    "gh CLI مفقود",
    "gh CLI mancante"
  ],
  [
    "gh: {0}",
    "gh: {0}",
    "gh: {0}",
    "gh: {0}",
    "gh: {0}",
    "gh: {0}"
  ],
  [
    "gh: not logged in",
    "gh: 未登录",
    "gh: 로그인되지 않음",
    "gh: ログインしていません",
    "gh: غير مسجل الدخول",
    "gh: non connesso"
  ],
  [
    "ghp_…",
    "ghp_…",
    "ghp_…",
    "ghp_…",
    "ghp_…",
    "ghp_…"
  ],
  [
    "ghp_… or github_pat_…",
    "ghp_… 或 github_pat_…",
    "ghp_… 또는 github_pat_…",
    "ghp_… または github_pat_…",
    "ghp_… أو github_pat_…",
    "ghp_… o github_pat_…"
  ],
  [
    "GiB",
    "GiB",
    "GiB",
    "GiB",
    "GiB",
    "GiB"
  ],
  [
    "GiB live",
    "GiB 实时",
    "GiB 생방송",
    "GiB ライブ",
    "GiB مباشر",
    "GiB live"
  ],
  [
    "Git repository",
    "Git 仓库",
    "Git 저장소",
    "Git リポジトリ",
    "مستودع Git",
    "Repository Git"
  ],
  [
    "GitHub",
    "GitHub",
    "GitHub",
    "GitHub",
    "GitHub",
    "GitHub"
  ],
  [
    "GitHub — {0}",
    "GitHub — {0}",
    "GitHub — {0}",
    "GitHub — {0}",
    "GitHub — {0}",
    "GitHub — {0}"
  ],
  [
    "GitHub API — repos, issues, PRs, files.",
    "GitHub API — 仓库、问题、拉取请求、文件。",
    "GitHub API — 저장소, 이슈, PR, 파일.",
    "GitHub API — リポジトリ、イシュー、プルリクエスト、ファイル。",
    "واجهة برمجة تطبيقات GitHub — المستودعات، القضايا، طلبات السحب، الملفات.",
    "API di GitHub — repository, issue, PR, file."
  ],
  [
    "GitHub is connected. Your chats, settings and agent teams will sync to a private",
    "GitHub 已连接。您的聊天、设置和代理团队将会同步到私有",
    "GitHub가 연결되었습니다. 귀하의 채팅, 설정 및 에이전트 팀이 개인적으로 동기화됩니다",
    "GitHub に接続されています。あなたのチャット、設定、エージェントチームはプライベートに同期されます",
    "GitHub متصل. ستتم مزامنة محادثاتك وإعداداتك وفرق الوكلاء إلى خاص",
    "GitHub è connesso. Le tue chat, impostazioni e team degli agenti saranno sincronizzati su un privato"
  ],
  [
    "github.com/",
    "github.com/",
    "github.com/",
    "github.com/",
    "github.com/",
    "github.com/"
  ],
  [
    "github.com/login/device",
    "github.com/login/device",
    "github.com/login/device",
    "github.com/login/device",
    "github.com/login/device",
    "github.com/login/device"
  ],
  [
    "Give a `key` to UPDATE a fact in place (e.g. key=build_command) instead of",
    "提供一个 `key` 来就地更新一个事实（例如 key=build_command），而不是",
    "사실을 제자리에서 업데이트하기 위해 `key`를 제공하세요 (예: key=build_command) 대신",
    "事実をその場で更新するために `key` を与える（例: key=build_command）、代わりに",
    "قدّم `مفتاح` لتحديث حقيقة في مكانها (مثال: key=build_command) بدلًا من",
    "Fornisci una `key` per AGGIORNARE un fatto in loco (es. key=build_command) invece di"
  ],
  [
    "Give this project's agents FULL ACCESS to your PC?",
    "是否授予此项目的代理对您的电脑完全访问权限？",
    "이 프로젝트의 에이전트가 귀하의 PC에 전체 액세스할 수 있도록 허용하시겠습니까?",
    "このプロジェクトのエージェントにあなたのPCへのフルアクセスを許可しますか？",
    "هل تمنح وكلاء هذا المشروع صلاحية الوصول الكامل إلى جهاز الكمبيوتر الخاص بك؟",
    "Dare a questo progetto degli agenti ACCESSO COMPLETO al tuo PC?"
  ],
  [
    "Glama directory",
    "Glama 目录",
    "Glama 디렉토리",
    "グラマディレクトリ",
    "دليل Glama",
    "Directory Glama"
  ],
  [
    "glob / grep, NOT in any OwLLM application folder.",
    "使用 glob / grep，不要在任何 OwLLM 应用程序文件夹中。",
    "glob / grep, 어느 OwLLM 애플리케이션 폴더에도 없음.",
    "glob / grep、OwLLM アプリケーションフォルダ内ではない。",
    "الاستخدام العام للأمر glob / grep، وليس في أي مجلد تطبيق OwLLM.",
    "glob / grep, NON in nessuna cartella dell'applicazione OwLLM."
  ],
  [
    "Glob pattern, e.g. 'src/**/*.tsx' or '*.py'.",
    "Glob 模式，例如 'src/**/*.tsx' 或 '*.py'。",
    "글롭 패턴, 예: 'src/**/*.tsx' 또는 '*.py'.",
    "グロブパターン、例: 'src/**/*.tsx' または '*.py'.",
    "نمط الغلوب، على سبيل المثال 'src/**/*.tsx' أو '*.py'.",
    "Pattern Glob, ad esempio 'src/**/*.tsx' o '*.py'."
  ],
  [
    "Go",
    "去",
    "이동",
    "移動",
    "اذهب",
    "Vai"
  ],
  [
    "Go back one entry in the persistent browser's history. Snapshot afterward to re-read elements.",
    "在持久浏览器的历史中返回一条记录。之后快照以重新读取元素。",
    "지속 브라우저의 히스토리에서 한 항목 뒤로 이동합니다. 요소를 다시 읽기 위해 이후에 스냅샷을 찍습니다.",
    "永続ブラウザの履歴で1つ前のエントリに戻ります。その後、要素を再読するためにスナップショットを取ります。",
    "ارجع خطوة واحدة في سجل المتصفح المستمر. التقط لقطة بعد ذلك لإعادة قراءة العناصر.",
    "Torna a una voce nella cronologia del browser persistente. Effettua uno snapshot dopo per rileggere gli elementi."
  ],
  [
    "go under <project>/brainstorm/.",
    "进入 <project>/brainstorm/ 下。",
    "<project>/brainstorm/ 아래로 이동합니다.",
    "<project>/brainstorm/ の下に移動します。",
    "انتقل إلى <project>/brainstorm/.",
    "vai sotto <project>/brainstorm/."
  ],
  [
    "Goal",
    "目标",
    "목표",
    "目標",
    "الهدف",
    "Obiettivo"
  ],
  [
    "Google Drive — list, read, search files. Requires OAuth setup (multi-step).",
    "Google 云端硬盘 — 列出、读取、搜索文件。需要设置 OAuth（多步骤）。",
    "구글 드라이브 — 파일 목록, 읽기, 검색. OAuth 설정 필요 (여러 단계).",
    "Google ドライブ — ファイルの一覧表示、読み取り、検索。OAuth 設定が必要（複数ステップ）。",
    "جوجل درايف — عرض الملفات، قراءتها، البحث فيها. يتطلب إعداد OAuth (متعدد الخطوات).",
    "Google Drive — elenca, leggi, cerca file. Richiede configurazione OAuth (a più passaggi)."
  ],
  [
    "Got it",
    "明白了",
    "알겠습니다",
    "了解",
    "فهمت",
    "Ricevuto"
  ],
  [
    "gotchas, prior findings). Call this BEFORE asking the user or re-deriving",
    "陷阱，之前的发现）。在询问用户或重新推导之前调用此项",
    "주의사항, 이전 발견 내용). 사용자에게 묻거나 재도출하기 전에 이 호출",
    "引っかかりや、以前の発見）。ユーザーに質問する前または再導出する前にこれを呼び出します",
    "مشكلات معروفة، النتائج السابقة). قم بالنداء بهذا قبل سؤال المستخدم أو إعادة استخلاصها",
    "problemi, risultati precedenti). Chiamare questo PRIMA di chiedere all'utente o di ri-derivare"
  ],
  [
    "GPU",
    "GPU",
    "GPU",
    "GPU",
    "وحدة معالجة الرسومات (GPU)",
    "GPU"
  ],
  [
    "GPU not detected (",
    "未检测到 GPU (",
    "GPU 감지되지 않음 (",
    "GPUが検出されません（",
    "لم يتم الكشف عن وحدة معالجة الرسومات (GPU)",
    "GPU non rilevata ("
  ],
  [
    "Grabs a screenshot automatically and opens a box to describe the issue.",
    "自动抓取屏幕截图并打开一个框来描述问题。",
    "자동으로 스크린샷을 찍고 문제를 설명할 수 있는 상자를 엽니다.",
    "スクリーンショットを自動で取得し、問題を説明するボックスを開きます。",
    "يلتقط لقطة شاشة تلقائيًا ويفتح مربعًا لوصف المشكلة.",
    "Cattura uno screenshot automaticamente e apre una finestra per descrivere il problema."
  ],
  [
    "Grant read access to your home folder for this run only (takes effect on re-run)",
    "仅对本次运行授予对您的主文件夹的读取访问权限（重新运行后生效）",
    "이번 실행에만 홈 폴더에 대한 읽기 권한을 부여합니다(다시 실행 시 적용됨)",
    "この実行に限りホームフォルダへの読み取りアクセスを付与します（再実行時に有効）",
    "منح إذن القراءة لمجلد المنزل الخاص بك لهذا التشغيل فقط (يسري عند إعادة التشغيل)",
    "Concedi l'accesso in lettura alla tua cartella home solo per questa esecuzione (effettivo al riavvio)"
  ],
  [
    "grants",
    "授予",
    "권한 부여",
    "付与",
    "منح",
    "concede"
  ],
  [
    "Grants these tools",
    "授予这些工具",
    "이 도구들에 권한 부여",
    "これらのツールを付与します",
    "يمنح هذه الأدوات",
    "Concede questi strumenti"
  ],
  [
    "graph",
    "图",
    "그래프",
    "グラフ",
    "رسم بياني",
    "grafo"
  ],
  [
    "Groq",
    "GROQ",
    "GROQ",
    "GROQ",
    "GROQ",
    "GROQ"
  ],
  [
    "GROQ",
    "GROQ",
    "그로크",
    "GROQ",
    "جروك",
    "GROQ"
  ],
  [
    "Guided WSL setup — install Ubuntu + Python automatically",
    "引导式 WSL 设置 — 自动安装 Ubuntu + Python",
    "WSL 안내 설정 — 우분투 + 파이썬 자동 설치",
    "ガイド付きWSLセットアップ — Ubuntu + Pythonを自動的にインストール",
    "إعداد WSL الموجه — تثبيت أوبونتو + بايثون تلقائيًا",
    "Configurazione guidata di WSL — installa automaticamente Ubuntu + Python"
  ],
  [
    "Guided WSL setup is only available on Windows.",
    "引导式 WSL 设置仅在 Windows 上可用。",
    "안내된 WSL 설정은 Windows에서만 사용할 수 있습니다.",
    "ガイド付きWSLセットアップはWindowsでのみ利用可能です。",
    "إعداد WSL الموجه متاح فقط على نظام ويندوز.",
    "La configurazione guidata di WSL è disponibile solo su Windows."
  ],
  [
    "Hard constraints — what it must always / never do.",
    "硬性约束 — 必须始终执行 / 绝不能执行的操作。",
    "강제 제약 — 항상 수행해야 하는 것 / 절대 수행하지 말아야 하는 것.",
    "ハード制約 — 常に実行すべきこと / 絶対にしてはいけないこと。",
    "القيود الصارمة — ما يجب أن يفعله دائمًا / لا يفعله أبدًا.",
    "Vincoli rigidi — ciò che deve sempre / mai fare."
  ],
  [
    "Headless Chromium — navigate, screenshot, click, scrape. Downloads Chromium on first run.",
    "无头 Chromium — 导航、截图、点击、抓取。在首次运行时下载 Chromium。",
    "헤드리스 크로미움 — 탐색, 스크린샷, 클릭, 스크랩. 첫 실행 시 크로미움 다운로드.",
    "ヘッドレスChromium — ナビゲート、スクリーンショット、クリック、スクレイピング。初回実行時にChromiumをダウンロードします。",
    "كروميوم بدون واجهة — التنقل، التقاط الشاشة، النقر، الكشط. يقوم بتنزيل كروميوم عند التشغيل لأول مرة.",
    "Chromium senza interfaccia — naviga, cattura schermate, clicca, estrai dati. Scarica Chromium al primo avvio."
  ],
  [
    "Heads up: without isolation the agent runs directly on your system and can read or modify any file your account can. The write-jail and dangerous-command guards still apply, and OWLLM is designed to be safely used by anyone — but unless you have a specific reason, we suggest keeping isolation on. The Linux VM adds a much stronger layer of protection.",
    "注意：如果没有隔离，代理将直接在你的系统上运行，并且可以读取或修改你账户可以访问的任何文件。写入监狱（write-jail）和危险命令（dangerous-command）保护仍然适用，而 OWLLM 设计为任何人都可以安全使用——但除非你有特定原因，我们建议保持隔离开启。Linux 虚拟机提供了更强的保护层。",
    "주의: 격리 없이 에이전트는 사용자의 시스템에서 직접 실행되며 계정이 접근할 수 있는 모든 파일을 읽거나 수정할 수 있습니다. write-jail 및 위험 명령어 보호 기능은 여전히 적용되며, OWLLM은 누구나 안전하게 사용할 수 있도록 설계되었습니다 — 하지만 특별한 이유가 없다면 격리를 켠 상태로 유지하는 것을 권장합니다. Linux VM은 훨씬 더 강력한 보호층을 제공합니다.",
    "注意: 分離なしでは、エージェントは直接あなたのシステム上で実行され、あなたのアカウントでアクセスできる任意のファイルを読み取ったり変更したりすることができます。write-jailおよび危険なコマンドに対するガードは依然として適用されますし、OWLLMは誰でも安全に使用できるように設計されています — しかし特別な理由がない限り、分離をオンにしておくことをお勧めします。Linux VMは、さらに強力な保護層を追加します。",
    "تنبيه: بدون العزل، يعمل الوكيل مباشرة على نظامك ويمكنه قراءة أو تعديل أي ملف يمكن لحسابك الوصول إليه. لا تزال تطبيقات الحماية من الأوامر الخطرة وكتابة السجن سارية، وتم تصميم OWLLM ليتم استخدامه بأمان من قبل أي شخص — ولكن ما لم يكن لديك سبب محدد، نقترح الحفاظ على العزل. تضيف آلة لينكس الافتراضية طبقة حماية أقوى بكثير.",
    "Attenzione: senza isolamento l'agente gira direttamente sul tuo sistema e può leggere o modificare qualsiasi file accessibile dal tuo account. Le protezioni write-jail e dangerous-command restano comunque attive, e OWLLM è progettato per essere usato in sicurezza da chiunque — ma a meno che tu non abbia un motivo specifico, suggeriamo di mantenere l'isolamento attivo. La VM Linux aggiunge un livello di protezione molto più forte."
  ],
  [
    "help",
    "帮助",
    "도움말",
    "ヘルプ",
    "مساعدة",
    "aiuto"
  ],
  [
    "help using the app",
    "使用应用的帮助",
    "앱 사용 안내",
    "アプリの使い方に関するヘルプ",
    "مساعدة في استخدام التطبيق",
    "Aiuto per usare l'app"
  ],
  [
    "Help using the app",
    "使用应用程序的帮助",
    "앱 사용 도움",
    "アプリの使い方を助ける",
    "المساعدة في استخدام التطبيق",
    "Aiuto nell'uso dell'app"
  ],
  [
    "Here's my screen — what do you see, and what should I do?",
    "这是我的屏幕——你看到什么，我应该做什么？",
    "제 화면입니다 — 무엇이 보이고, 제가 무엇을 해야 할까요?",
    "これが私の画面です — あなたには何が見えますか？ そして、私は何をすべきですか？",
    "إليك شاشتي — ماذا ترى، وماذا يجب أن أفعل؟",
    "Ecco il mio schermo — cosa vedi, e cosa dovrei fare?"
  ],
  [
    "Hermes",
    "赫尔墨斯",
    "헤르메스",
    "ヘルメス",
    "هيرميس",
    "Hermes"
  ],
  [
    "hidden",
    "隐藏",
    "숨기기",
    "非表示",
    "مخفية",
    "nascosto"
  ],
  [
    "Hide",
    "隐藏",
    "숨기기",
    "隠す",
    "إخفاء",
    "Nascondi"
  ],
  [
    "Hide (shell keeps running — reopen from the 🖥 Terminal button)",
    "隐藏（shell 仍在运行——从 🖥 终端按钮重新打开）",
    "숨기기 (쉘은 계속 실행됨 — 🖥 터미널 버튼에서 다시 열기)",
    "非表示 (シェルは実行を続けます — 🖥 ターミナルボタンから再度開いてください)",
    "إخفاء (القشرة تظل تعمل — أعد فتحها من زر 🖥 Terminal)",
    "Nascondi (la shell continua a funzionare — riaprila dal pulsante 🖥 Terminal)"
  ],
  [
    "Hide checks",
    "隐藏检查",
    "체크 숨기기",
    "チェックを隠す",
    "إخفاء الفحوصات",
    "Nascondi controlli"
  ],
  [
    "Hide log",
    "隐藏日志",
    "로그 숨기기",
    "ログを隠す",
    "إخفاء السجل",
    "Nascondi registro"
  ],
  [
    "Hide readiness checks",
    "隐藏准备检查",
    "준비 상태 체크 숨기기",
    "準備チェックを隠す",
    "إخفاء فحوصات الجاهزية",
    "Nascondi controlli di prontezza"
  ],
  [
    "Hide the worklog transcript — show only the durable knowledge (facts)",
    "隐藏工作日志记录 — 仅显示持久知识（事实）",
    "작업 로그 기록 숨기기 — 내구성 있는 지식(사실)만 표시",
    "作業ログの記録を隠す — 永続的な知識（事実）のみを表示する",
    "إخفاء نص سجل العمل — عرض المعرفة الدائمة فقط (الحقائق)",
    "Nascondi la trascrizione del registro di lavoro — mostra solo la conoscenza duratura (fatti)"
  ],
  [
    "Hide token option",
    "隐藏令牌选项",
    "토큰 옵션 숨기기",
    "トークンオプションを隠す",
    "إخفاء خيار الرمز",
    "Nascondi opzione token"
  ],
  [
    "home",
    "主页",
    "홈",
    "ホーム",
    "الصفحة الرئيسية",
    "home"
  ],
  [
    "host",
    "主机",
    "호스트",
    "ホスト",
    "المضيف",
    "Host"
  ],
  [
    "Host",
    "主机",
    "호스트",
    "ホスト",
    "مضيف",
    "Ospite"
  ],
  [
    "Host — build + sign + publish on this machine",
    "主机 — 在此机器上构建 + 签名 + 发布",
    "호스트 — 이 머신에서 빌드 + 서명 + 배포",
    "ホスト — このマシンでビルド + 署名 + 公開",
    "المضيف — البناء + التوقيع + النشر على هذه الآلة",
    "Host — costruisci + firma + pubblica su questa macchina"
  ],
  [
    "host / IP (e.g. 192.168.1.20)",
    "主机 / IP（例如 192.168.1.20）",
    "호스트 / IP (예: 192.168.1.20)",
    "ホスト / IP（例: 192.168.1.20）",
    "المضيف / IP (مثل 192.168.1.20)",
    "host / IP (ad es. 192.168.1.20)"
  ],
  [
    "Host a relay on this machine (bind 0.0.0.0:47772) — for an always-on box with a public URL/tunnel",
    "在此机器上托管中继（绑定 0.0.0.0:47772） — 用于一个始终在线且具有公共 URL/隧道的设备",
    "이 머신에서 릴레이 호스트(0.0.0.0:47772 바인딩) — 공용 URL/터널이 있는 항상 켜져 있는 박스용",
    "このマシンでリレーをホストする（0.0.0.0:47772にバインド） — 公開URL/トンネルを持つ常時稼働ボックス用",
    "استضافة مرحل على هذه الآلة (ربط 0.0.0.0:47772) — لصندوق دائم التشغيل مع عنوان URL/نفق عام",
    "Ospita un relay su questa macchina (bind 0.0.0.0:47772) — per un computer sempre acceso con un URL pubblico/tunnel"
  ],
  [
    "Host build",
    "主机构建",
    "호스트 빌드",
    "ホストビルド",
    "إنشاء المضيف",
    "Compilazione host"
  ],
  [
    "HOST mode",
    "主机模式",
    "호스트 모드",
    "ホストモード",
    "وضع المضيف",
    "Modalità HOST"
  ],
  [
    "Host mode publishes immediately from this machine. CI mode relies on GitHub Actions runners, which are currently unavailable due to billing limits.",
    "主机模式立即从此机器发布。CI 模式依赖 GitHub Actions 运行器，由于账单限制，目前不可用。",
    "호스트 모드는 이 기계에서 바로 게시합니다. CI 모드는 GitHub Actions 러너를 사용하며, 현재 요금 제한으로 인해 사용할 수 없습니다.",
    "ホストモードはこのマシンからすぐに公開します。CIモードはGitHub Actionsランナーに依存しており、現在は課金制限のため利用できません。",
    "وضع المضيف ينشر فورًا من هذه الآلة. وضع CI يعتمد على مشغلات GitHub Actions، والتي هي غير متوفرة حاليًا بسبب حدود الفوترة.",
    "La modalità host pubblica immediatamente da questa macchina. La modalità CI si basa sui runner di GitHub Actions, attualmente non disponibili a causa dei limiti di fatturazione."
  ],
  [
    "Host needs the build toolchain and signing cert on this computer. CI needs a working GitHub Actions workflow and billing.",
    "主机需要在此计算机上安装构建工具链和签名证书。CI 需要一个可工作的 GitHub Actions 工作流和账单。",
    "호스트는 이 컴퓨터에서 빌드 툴체인과 서명 인증서가 필요합니다. CI는 작동하는 GitHub Actions 워크플로우와 결제가 필요합니다.",
    "ホストにはこのコンピュータ上でビルドツールチェーンと署名証明書が必要です。CIには、動作するGitHub Actionsワークフローと課金が必要です。",
    "المضيف يحتاج إلى سلسلة أدوات البناء وشهادة التوقيع على هذا الكمبيوتر. وضع CI يحتاج إلى سير عمل يعمل على GitHub Actions والفوترة.",
    "L'host ha bisogno della toolchain di compilazione e del certificato di firma su questo computer. La CI necessita di un flusso di lavoro GitHub Actions funzionante e della fatturazione."
  ],
  [
    "How it works:",
    "工作原理：",
    "작동 방식:",
    "仕組み:",
    "كيف يعمل:",
    "Come funziona:"
  ],
  [
    "How long the last run took",
    "上次运行耗时",
    "마지막 실행에 걸린 시간",
    "前回の実行にかかった時間",
    "مدة تشغيل آخر مرة",
    "Quanto tempo ha impiegato l'ultima esecuzione"
  ],
  [
    "How long the last turn took",
    "上次轮次耗时",
    "마지막 턴에 걸린 시간",
    "前回のターンにかかった時間",
    "مدة آخر عملية",
    "Quanto tempo ha impiegato l'ultimo turno"
  ],
  [
    "How long this agent has worked (cumulative)",
    "此代理工作总时长（累计）",
    "이 에이전트가 작업한 시간(누적)",
    "このエージェントが作業した時間（累積）",
    "مدة عمل هذا الوكيل (تراكمية)",
    "Quanto tempo ha lavorato questo agente (cumulativo)"
  ],
  [
    "How many pairs to ask the model for per chunk",
    "每个块向模型请求的配对数",
    "청크당 모델에 요청할 쌍 수",
    "チャンクごとにモデルに尋ねるペアの数",
    "كم عدد الأزواج لطلبها من النموذج لكل جزء",
    "Quante coppie chiedere al modello per ciascun blocco"
  ],
  [
    "How many results to return (1-20, default 5).",
    "要返回的结果数（1-20，默认 5）",
    "반환할 결과 수(1-20, 기본값 5)",
    "返す結果の数（1〜20、デフォルトは5）",
    "كم عدد النتائج لإرجاعها (1-20، الافتراضي 5).",
    "Quanti risultati restituire (1-20, predefinito 5)."
  ],
  [
    "How many tokens the model keeps in context. Larger needs more VRAM for the KV cache.",
    "模型在上下文中保留了多少令牌。更大的模型需要更多显存用于 KV 缓存。",
    "모델이 컨텍스트에서 보관하는 토큰 수. 더 크면 KV 캐시를 위해 더 많은 VRAM이 필요합니다.",
    "モデルが文脈の中で何枚のトークンを保持しているか。大きいほどKVキャッシュ用により多くのVRAMが必要です。",
    "كم عدد الرموز التي يحتفظ بها النموذج في السياق. النماذج الأكبر تحتاج المزيد من ذاكرة VRAM لمخزن KV.",
    "Quanti token il modello mantiene in contesto. Più grande necessita di più VRAM per la cache KV."
  ],
  [
    "how they're wired together, and which MCP servers it needs.",
    "它们如何连接在一起，以及需要哪些 MCP 服务器。",
    "그들이 어떻게 연결되어 있는지, 그리고 어떤 MCP 서버가 필요한지.",
    "どのように配線されているか、どのMCPサーバーが必要かも知りたいです。",
    "كيف يتم وصلها معًا، وأي خوادم MCP يحتاجها.",
    "come sono collegati tra loro e quali server MCP sono necessari."
  ],
  [
    "How to know the work is complete — the bar to clear before handing back.",
    "如何判断工作已完成——在交回之前需达成的标准。",
    "작업이 완료되었는지 알 수 있는 방법 — 반환하기 전에 넘어야 할 기준.",
    "作業が完了したことを知る方法 — 引き渡す前にクリアすべき基準。",
    "كيفية معرفة أن العمل مكتمل — العتبة التي يجب تجاوزها قبل إعادته.",
    "Come sapere che il lavoro è completo — il livello da superare prima di restituirlo."
  ],
  [
    "HOW TO READ IT — the most recent entries are injected into your prompt below as a",
    "如何阅读 —— 最近的条目已注入到您下面的提示中",
    "읽는 방법 — 가장 최근 항목이 아래 프롬프트에 삽입됩니다",
    "読み方 — 最新のエントリは、以下のプロンプトに挿入されます",
    "كيفية قراءته — يتم إدراج أحدث الإدخالات في مطالبتك أدناه كـ",
    "COME LEGGERE — le voci più recenti sono inserite nel tuo prompt qui sotto come un"
  ],
  [
    "HOW TO WRITE IT (works on EVERY model) — to record a stable, reusable fact (NOT",
    "如何书写（适用于所有模型）——记录一个稳定、可重用的事实（不是",
    "작성 방법 (모든 모델에서 작동) — 안정적이고 재사용 가능한 사실을 기록하려면 (아님",
    "書き方（すべてのモデルで動作します） — 安定した再利用可能な事実を記録するために（NOT",
    "كيفية كتابته (يعمل على كل نموذج) — لتسجيل حقيقة مستقرة وقابلة لإعادة الاستخدام (ليس",
    "COME SCRIVERE (funziona su TUTTI i modelli) — per registrare un fatto stabile e riutilizzabile (NON"
  ],
  [
    "ℹ️ Info",
    "ℹ 信息",
    "ℹ 정보",
    "ℹ 情報",
    "ℹ معلومات",
    "ℹ Informazioni"
  ],
  [
    "ℹ Info",
    "ℹ 信息",
    "ℹ 정보",
    "ℹ 情報",
    "ℹ معلومات",
    "ℹ Informazioni"
  ],
  [
    "idle",
    "空闲",
    "유휴",
    "アイドル",
    "خامل",
    "Inattivo"
  ],
  [
    "Idle",
    "空闲",
    "유휴",
    "アイドル",
    "خامل",
    "Inattivo"
  ],
  [
    "idle — steps start a run",
    "空闲 — 步骤启动运行",
    "대기 — 단계가 실행을 시작합니다",
    "アイドル — 手順が実行を開始します",
    "خامل — الخطوات تبدأ تشغيل",
    "inattivo — i passaggi avviano un'esecuzione"
  ],
  [
    "idle — team pings you here",
    "空闲 — 团队在此向您发送提醒",
    "대기 — 팀이 여기에 알림을 보냅니다",
    "アイドル — チームがここで通知します",
    "خامل — الفريق يرسل لك إشعارات هنا",
    "inattivo — il team ti segnala qui"
  ],
  [
    "ies",
    "ies",
    "예",
    "ies",
    "ios",
    "ios"
  ],
  [
    "if your model isn't supported by Unsloth or you want maximum compatibility.",
    "如果你的模型不受 Unsloth 支持，或你想要最大兼容性。",
    "모델이 Unsloth에서 지원되지 않거나 최대 호환성을 원할 때.",
    "もしあなたのモデルがUnslothでサポートされていないか、最大限の互換性を求めている場合。",
    "إذا لم يكن نموذجك مدعومًا من قبل Unsloth أو أردت أقصى قدر من التوافق.",
    "se il tuo modello non è supportato da Unsloth o vuoi la massima compatibilità."
  ],
  [
    "image",
    "图片",
    "이미지",
    "画像",
    "صورة",
    "immagine"
  ],
  [
    "IMAP + SMTP · use a dedicated mailbox · no public URL",
    "IMAP + SMTP · 使用专用邮箱 · 无公共网址",
    "IMAP + SMTP · 전용 메일박스 사용 · 공개 URL 없음",
    "IMAP + SMTP · 専用のメールボックスを使用 · 公開URLなし",
    "IMAP + SMTP · استخدم صندوق بريد مخصص · لا يوجد رابط عام",
    "IMAP + SMTP · usa una casella di posta dedicata · nessun URL pubblico"
  ],
  [
    "imap.gmail.com",
    "imap.gmail.com",
    "imap.gmail.com",
    "imap.gmail.com",
    "imap.gmail.com",
    "imap.gmail.com"
  ],
  [
    "import",
    "导入",
    "가져오기",
    "インポート",
    "استيراد",
    "Importa"
  ],
  [
    "Import",
    "导入",
    "가져오기",
    "インポート",
    "استيراد",
    "Importa"
  ],
  [
    "Import asset",
    "导入资产",
    "자산 가져오기",
    "アセットをインポート",
    "استيراد أصل",
    "Importa risorsa"
  ],
  [
    "Import certificate…",
    "导入证书…",
    "인증서 가져오기…",
    "証明書をインポート…",
    "استيراد الشهادة…",
    "Certificato di importazione…"
  ],
  [
    "Import from your browsers",
    "从你的浏览器导入",
    "브라우저에서 가져오기",
    "ブラウザからインポート",
    "استيراد من متصفحاتك",
    "Importa dal tuo browser"
  ],
  [
    "Import media asset",
    "导入媒体资产",
    "미디어 자산 가져오기",
    "メディアアセットをインポート",
    "استيراد أصل وسائط",
    "Importa risorsa multimediale"
  ],
  [
    "Import saved logins from your installed browsers into the vault.",
    "将已保存的登录信息从你已安装的浏览器导入保管库。",
    "설치된 브라우저에서 저장된 로그인 정보를 금고로 가져오기.",
    "インストール済みのブラウザから保存されたログイン情報をボールトにインポートします。",
    "استيراد تسجيلات الدخول المحفوظة من المتصفحات المثبتة لديك إلى الخزنة.",
    "Importa accessi salvati dai browser installati nella cassaforte."
  ],
  [
    "Importing…",
    "导入中…",
    "가져오는 중…",
    "インポート中…",
    "جاري الاستيراد…",
    "Importazione in corso…"
  ],
  [
    "In the share dialog, choose",
    "在共享对话框中，选择",
    "공유 대화상자에서 선택",
    "共有ダイアログで、選択してください",
    "في مربع الحوار المشاركة، اختر",
    "Nella finestra di condivisione, scegli"
  ],
  [
    "In the share dialog, click “Entire Screen” and pick the screen OWLLM is on — I crop it to just the app (frame included). Press Ctrl+Shift+R to stop.",
    "在共享对话框中，点击“整个屏幕”，然后选择 OWLLM 所在的屏幕 — 我把它裁剪为只有应用程序（包含框架）。按 Ctrl+Shift+R 停止。",
    "공유 대화 상자에서 '전체 화면'을 클릭하고 OWLLM이 있는 화면을 선택하세요 — 저는 앱만 포함하도록 (프레임 포함) 잘라냅니다. 중지하려면 Ctrl+Shift+R을 누르세요.",
    "共有ダイアログで「画面全体」をクリックし、OWLLMがある画面を選択します — 私はアプリだけ（フレームを含む）に切り取ります。停止するには Ctrl+Shift+R を押します。",
    "في مربع الحوار المشاركة، انقر على \"الشاشة بأكملها\" واختر الشاشة التي يعمل عليها OWLLM — أنا أقوم بقصها لتشمل التطبيق فقط (بما في ذلك الإطار). اضغط على Ctrl+Shift+R للإيقاف.",
    "Nella finestra di condivisione, clicca su “Schermo intero” e scegli lo schermo su cui è OWLLM — lo ritaglio solo all’app (includendo il frame). Premi Ctrl+Shift+R per fermare."
  ],
  [
    "in your browser and",
    "在你的浏览器中，并且",
    "브라우저에서 그리고",
    "ブラウザで",
    "في متصفحك و",
    "nel tuo browser e"
  ],
  [
    "In your library — not downloaded on this device.",
    "在你的库中 — 尚未下载到此设备。",
    "라이브러리에서 — 이 장치에 다운로드되지 않음.",
    "ライブラリ内 — このデバイスにはダウンロードされていません。",
    "في مكتبتك — لم يتم تنزيلها على هذا الجهاز.",
    "Nella tua libreria — non scaricato su questo dispositivo."
  ],
  [
    "In your model library (downloaded on another device) — not on this PC yet",
    "在你的模型库中（已在另一台设备下载）— 此电脑上尚未下载",
    "모델 라이브러리에서 (다른 장치에서 다운로드됨) — 아직 이 PC에 없음",
    "モデルライブラリ内（別のデバイスでダウンロード済み） — このPCにはまだありません",
    "في مكتبة النماذج الخاصة بك (تم تنزيلها على جهاز آخر) — لم يتم تنزيلها على هذا الكمبيوتر بعد",
    "Nella tua libreria di modelli (scaricato su un altro dispositivo) — non ancora su questo PC"
  ],
  [
    "In your Slack app: turn on",
    "在您的 Slack 应用中：开启",
    "귀하의 Slack 앱에서: 켜기",
    "あなたのSlackアプリで：オンにしてください",
    "في تطبيق Slack الخاص بك: قم بتشغيل",
    "Nella tua app Slack: attiva"
  ],
  [
    "Incoming connections land here",
    "传入连接到达此处",
    "수신 연결이 여기에 도착합니다",
    "着信接続はここに到達します",
    "تصل الاتصالات الواردة هنا",
    "Le connessioni in arrivo arrivano qui"
  ],
  [
    "Indigo",
    "靛蓝色",
    "인디고",
    "インディゴ",
    "إنديغو",
    "Indigo"
  ],
  [
    "info",
    "信息",
    "정보",
    "情報",
    "معلومات",
    "informazioni"
  ],
  [
    "input",
    "输入",
    "입력",
    "入力",
    "إدخال",
    "input"
  ],
  [
    "Input element index from the latest browser_snapshot.",
    "来自最新浏览器快照的输入元素索引。",
    "최신 브라우저 스냅샷에서 입력 요소 인덱스.",
    "最新のブラウザスナップショットからの入力要素のインデックス。",
    "مؤشر عنصر الإدخال من أحدث لقطة للمتصفح.",
    "Indice dell'elemento di input dall'ultimo snapshot del browser."
  ],
  [
    "Insert @reference into the composer so the model edits this file",
    "在编辑器中插入 @reference，以便模型编辑此文件",
    "작곡기에 @reference를 삽입하여 모델이 이 파일을 편집하도록 합니다",
    "@reference を作成者に挿入して、このファイルをモデルが編集するようにします",
    "أدخل @reference في المُؤلف كي يقوم النموذج بتحرير هذا الملف",
    "Inserisci @riferimento nel compositore in modo che il modello modifichi questo file"
  ],
  [
    "inside it so the Coder and fine-tuning work.",
    "在其中以便 Coder 和微调能工作。",
    "그 안에서 Coder와 미세 조정이 작동합니다.",
    "その内部で、Coder とファインチューニングが動作します。",
    "داخله حتى يعمل المبرمج والتخصيص الدقيق.",
    "all'interno affinché il Coder e il fine-tuning funzionino."
  ],
  [
    "install",
    "安装",
    "설치",
    "インストール",
    "تثبيت",
    "installa"
  ],
  [
    "Install {0} module{1}",
    "安装 {0} 模块{1}",
    "{0} 모듈{1} 설치",
    "{0} モジュール{1}をインストール",
    "تثبيت وحدة {0}{1}",
    "Installa il modulo {0}{1}"
  ],
  [
    "Install / login log",
    "安装/登录日志",
    "설치 / 로그인 로그",
    "インストール / ログインログ",
    "سجل التثبيت / تسجيل الدخول",
    "Installa / registra accesso"
  ],
  [
    "Install a system voice to enable preview",
    "安装系统语音以启用预览",
    "미리보기를 가능하게 하려면 시스템 음성 설치",
    "プレビューを有効にするためにシステム音声をインストールしてください",
    "تثبيت صوت نظام لتمكين المعاينة",
    "Installa una voce di sistema per abilitare l'anteprima"
  ],
  [
    "Install Anthropic's official skill pack (PDF, Excel, Word helpers — drop-in compatible) to give your agents pro-grade capabilities out of the box.",
    "安装Anthropic的官方技能包（PDF、Excel、Word助手——即插即用兼容），让你的代理开箱即可拥有专业级功能。",
    "Anthropic의 공식 스킬 팩(PDF, Excel, Word 도우미 — 바로 사용 가능한 호환)을 설치하여 에이전트에게 기본적으로 전문가 수준의 기능을 제공하세요.",
    "Anthropicの公式スキルパック（PDF、Excel、Wordヘルパー—ドロップイン互換）をインストールして、エージェントにすぐにプロ級の能力を付与しましょう。",
    "قم بتثبيت حزمة المهارات الرسمية من Anthropic (مساعدات PDF و Excel و Word — متوافقة مباشرة) لمنح وكلائك قدرات احترافية مباشرة من الصندوق.",
    "Installa il pacchetto di competenze ufficiale di Anthropic (helper PDF, Excel, Word — compatibili plug-in) per fornire ai tuoi agenti capacità di livello professionale subito pronte all'uso."
  ],
  [
    "Install community SKILL.md packs from curated git sources. Anthropic-style tool names (",
    "从精选的git资源安装社区SKILL.md包。Anthropic风格的工具名称（",
    "큐레이션된 git 소스에서 커뮤니티 SKILL.md 팩을 설치합니다. Anthropic 스타일 도구 이름(",
    "厳選されたGitソースからコミュニティのSKILL.mdパックをインストールします。Anthropicスタイルのツール名（",
    "قم بتثبيت حزم SKILL.md المجتمعية من مصادر git المختارة. أسماء الأدوات على طراز أنثروبيك (",
    "Installa i pacchetti SKILL.md della community da fonti git selezionate. Nomi degli strumenti in stile Anthropic ("
  ],
  [
    "Install Lima/bubblewrap.",
    "安装Lima/bubblewrap。",
    "Lima/bubblewrap을 설치합니다.",
    "Lima/bubblewrapをインストールします。",
    "قم بتثبيت Lima/bubblewrap.",
    "Installa Lima/bubblewrap."
  ],
  [
    "Install MCP pack",
    "安装MCP包",
    "MCP 팩을 설치합니다.",
    "MCPパックをインストールします",
    "قم بتثبيت حزمة MCP",
    "Installa il pacchetto MCP"
  ],
  [
    "Install Node.js toolchain?",
    "安装Node.js工具链？",
    "Node.js 도구 체인을 설치하시겠습니까?",
    "Node.jsツールチェーンをインストールしますか？",
    "هل تريد تثبيت أداة Node.js؟",
    "Installa la toolchain Node.js?"
  ],
  [
    "Install now",
    "立即安装",
    "지금 설치",
    "今すぐインストール",
    "قم بالتثبيت الآن",
    "Installa ora"
  ],
  [
    "Install selected",
    "安装选定项",
    "선택한 항목 설치",
    "選択したものをインストール",
    "قم بتثبيت العناصر المحددة",
    "Installa selezionato"
  ],
  [
    "Install SKILL.md packs from a curated source (Anthropic, obra/superpowers) or a git URL",
    "从精选资源（Anthropic, obra/superpowers）或git URL安装SKILL.md包",
    "큐레이션된 소스(Anthropic, obra/superpowers) 또는 git URL에서 SKILL.md 팩을 설치합니다.",
    "厳選されたソース（Anthropic、obra/superpowers）またはGit URLからSKILL.mdパックをインストールします",
    "قم بتثبيت حزم SKILL.md من مصدر مختار (أنثروبيك، obra/superpowers) أو من خلال رابط git",
    "Installa i pacchetti SKILL.md da una fonte selezionata (Anthropic, obra/superpowers) o da un URL git"
  ],
  [
    "Install the fine-tuning environment first — open Environment (button next to the model).",
    "首先安装微调环境——打开环境（模型旁边的按钮）。",
    "먼저 파인튜닝 환경을 설치하세요 — 환경 열기(모델 옆 버튼)를 클릭하세요.",
    "まずファインチューニング環境をインストールします — モデルの隣にある環境ボタンを開きます。",
    "قم بتثبيت بيئة التخصيص أولاً — افتح البيئة (الزر بجانب النموذج).",
    "Installa prima l'ambiente di fine-tuning — apri Ambiente (pulsante accanto al modello)."
  ],
  [
    "Install the MCP servers this workflow expects.",
    "安装该工作流程所需的MCP服务器。",
    "이 워크플로우에서 예상하는 MCP 서버를 설치하세요.",
    "このワークフローが期待するMCPサーバーをインストールしてください。",
    "قم بتثبيت خوادم MCP التي يتوقعها هذا التدفق.",
    "Installa i server MCP che questo flusso di lavoro si aspetta."
  ],
  [
    "install uv: {0}",
    "安装 uv: {0}",
    "uv 설치: {0}",
    "uvをインストール: {0}",
    "تثبيت uv: {0}",
    "installa uv: {0}"
  ],
  [
    "Install voice runtime",
    "安装语音运行时",
    "음성 런타임 설치",
    "音声ランタイムをインストール",
    "تثبيت بيئة تشغيل الصوت",
    "Installa runtime vocale"
  ],
  [
    "Install WSL + Ubuntu",
    "安装 WSL + Ubuntu",
    "WSL + Ubuntu 설치",
    "WSL + Ubuntuをインストール",
    "تثبيت WSL + أوبونتو",
    "Installa WSL + Ubuntu"
  ],
  [
    "Install WSL to isolate them.",
    "安装 WSL 以隔离它们。",
    "WSL을 설치하여 분리하세요.",
    "それらを隔離するためにWSLをインストール",
    "تثبيت WSL لعزلها.",
    "Installa WSL per isolarli."
  ],
  [
    "installed",
    "已安装",
    "설치됨",
    "インストール済み",
    "تم التثبيت",
    "INSTALLATO"
  ],
  [
    "INSTALLED",
    "已安装",
    "설치됨",
    "インストール済み",
    "مُثبت",
    "INSTALLATO"
  ],
  [
    "Installed {0} skill{1}.",
    "已安装 {0} 技能{1}。",
    "{0} 스킬{1} 설치됨.",
    "{0}スキル{1}をインストールしました。",
    "تم تثبيت مهارة {0}{1}.",
    "Installata la competenza {0}{1}."
  ],
  [
    "Installed {0}, {1} failed: {2}",
    "已安装 {0}，{1} 失败: {2}",
    "{0} 설치됨, {1} 실패: {2}",
    "{0}をインストールしました、{1}は失敗しました: {2}",
    "تم تثبيت {0}، فشل {1}: {2}",
    "Installato {0}, {1} fallito: {2}"
  ],
  [
    "installed and working on this PC — but the only Linux in it is",
    "已安装并在此电脑上运行——但里面唯一的 Linux 是",
    "이 PC에 설치되어 있고 작동 중 — 하지만 그 안에 있는 유일한 Linux는",
    "このPCにインストールされていて動作しています — しかし、その中の唯一のLinuxは",
    "مثبت ويعمل على هذا الكمبيوتر — لكن نظام Linux الوحيد فيه هو",
    "installato e funzionante su questo PC — ma l'unico Linux presente è"
  ],
  [
    "installed search MCP server (e.g. DuckDuckGo, which needs no key) is",
    "已安装搜索 MCP 服务器（例如 DuckDuckGo，无需密钥）",
    "설치된 검색 MCP 서버(예: 키가 필요 없는 DuckDuckGo)는",
    "インストールされた検索MCPサーバー（例: DuckDuckGo、キー不要）は",
    "خادم MCP المثبت للبحث (مثال: DuckDuckGo، الذي لا يحتاج لمفتاح) هو",
    "server MCP di ricerca installato (ad es. DuckDuckGo, che non necessita di chiave) è"
  ],
  [
    "installing",
    "正在安装",
    "설치 중",
    "インストール中",
    "جارٍ التثبيت",
    "installando"
  ],
  [
    "Installing {0}…",
    "正在安装 {0}…",
    "{0} 설치 중…",
    "{0}をインストールしています…",
    "تثبيت {0}…",
    "Installazione di {0}…"
  ],
  [
    "Installing agent tools in {0} (node, uv, git, CLIs)… this can take a few minutes.",
    "在 {0} 中安装代理工具（node、uv、git、命令行工具）… 这可能需要几分钟。",
    "{0}에 에이전트 도구 설치 중 (node, uv, git, CLI)… 몇 분 걸릴 수 있습니다.",
    "{0}にエージェントツールをインストール中（node、uv、git、CLI）… これには数分かかることがあります。",
    "تثبيت أدوات الوكيل في {0} (node، uv، git، واجهات الأوامر)… قد يستغرق هذا بضع دقائق.",
    "Installazione degli strumenti dell'agente in {0} (node, uv, git, CLI)… questo può richiedere alcuni minuti."
  ],
  [
    "Installing agent tools…",
    "正在安装代理工具…",
    "에이전트 도구 설치 중…",
    "エージェントツールをインストール中…",
    "تثبيت أدوات الوكيل…",
    "Installazione degli strumenti dell'agente…"
  ],
  [
    "Installing...",
    "正在安装……",
    "설치 중…",
    "インストール中…",
    "جارٍ التثبيت…",
    "Installazione in corso..."
  ],
  [
    "Installing…",
    "正在安装…",
    "설치 중…",
    "インストール中…",
    "جارٍ التثبيت…",
    "Installazione…"
  ],
  [
    "INSTRUCTION",
    "指令",
    "지침",
    "指示",
    "تعليمات",
    "ISTRUZIONE"
  ],
  [
    "Instructions · SKILL.md body (",
    "说明 · SKILL.md 正文 (",
    "지침 · SKILL.md 본문 (",
    "指示 · SKILL.md 本文 (",
    "التعليمات · جسم SKILL.md (",
    "Istruzioni · Corpo di SKILL.md ("
  ],
  [
    "integrating",
    "集成",
    "통합",
    "統合中",
    "الدمج",
    "integrazione"
  ],
  [
    "Integrating…",
    "集成中…",
    "통합 중…",
    "統合中…",
    "الدمج…",
    "Integrazione…"
  ],
  [
    "Intel Virtualization Technology (VT-x)",
    "英特尔虚拟化技术 (VT-x)",
    "인텔 가상화 기술(VT-x)",
    "Intel 仮想化技術 (VT-x)",
    "تقنية افتراضية من إنتل (VT-x)",
    "Tecnologia di virtualizzazione Intel (VT-x)"
  ],
  [
    "intent for this bot in the Discord Developer Portal, or message text arrives empty.",
    "在 Discord 开发者门户中为此机器人设置意图，或者消息文本为空时。",
    "Discord 개발자 포털에서 이 봇에 대한 의도, 또는 메시지 텍스트가 비어 있음.",
    "Discord 開発者ポータルでこのボットの意図、またはメッセージテキストが空で到着する場合。",
    "نية هذا البوت في بوابة مطوري Discord، أو وصول نص الرسالة فارغ.",
    "intento per questo bot nel Discord Developer Portal, o il testo del messaggio arriva vuoto."
  ],
  [
    "investigates, gathers facts, reads docs/APIs",
    "调查、收集事实、阅读文档/API",
    "조사하고, 사실을 수집하며, 문서/API를 읽음",
    "調査、事実の収集、ドキュメント/API の読み取り",
    "يحقق، يجمع الحقائق، يقرأ الوثائق / واجهات برمجة التطبيقات",
    "indaga, raccoglie fatti, legge documentazione/API"
  ],
  [
    "IP / hostname",
    "IP / 主机名",
    "IP / 호스트 이름",
    "IP / ホスト名",
    "IP / اسم المضيف",
    "IP / nome host"
  ],
  [
    "is",
    "是",
    "이다",
    "です",
    "هو",
    "è"
  ],
  [
    "is ready on this device. Your chats, settings and agent teams sync here.",
    "此设备已准备就绪。您的聊天、设置和代理团队会同步到这里。",
    "이 장치에서 준비 완료. 채팅, 설정 및 에이전트 팀이 여기에서 동기화됩니다.",
    "このデバイスで準備完了です。チャット、設定、エージェントチームはここで同期されます。",
    "جاهز على هذا الجهاز. تتم مزامنة محادثاتك، وإعداداتك، وفرق الوكلاء هنا.",
    "è pronto su questo dispositivo. Le tue chat, impostazioni e team dell'agente si sincronizzano qui."
  ],
  [
    "is the master gate (off = no MCP tools reach any agent, nothing spawns); each server's",
    "是主网关（关闭 = 没有 MCP 工具可访问任何代理，什么都不会生成）；每个服务器的",
    "마스터 게이트입니다 (off = 어떤 MCP 도구도 에이전트에 도달하지 않으며, 아무것도 생성되지 않음); 각 서버의",
    "マスターゲート (オフ = MCPツールはどのエージェントにも到達せず、何も生成されません); 各サーバー",
    "هو البوابة الرئيسية (إيقاف = لا تصل أي أدوات MCP إلى أي وكيل، لا يتم إنشاء أي شيء)؛ كل خادم",
    "è il cancello principale (off = nessuno strumento MCP raggiunge alcun agente, nulla viene generato); ogni server"
  ],
  [
    "Isolated: tools run inside Linux (WSL) and cannot touch your Windows files.",
    "隔离：工具在 Linux (WSL) 内运行，无法访问你的 Windows 文件。",
    "격리됨: 도구는 Linux(WSL) 내에서 실행되며 Windows 파일에 접근할 수 없습니다.",
    "分離: ツールはLinux（WSL）内で実行され、Windowsのファイルには触れられません。",
    "معزول: الأدوات تعمل داخل لينكس (WSL) ولا يمكنها الوصول إلى ملفات ويندوز الخاصة بك.",
    "Isolato: gli strumenti vengono eseguiti all'interno di Linux (WSL) e non possono toccare i tuoi file Windows."
  ],
  [
    "Isolation Bunker",
    "隔离地堡",
    "격리 벙커",
    "アイソレーションバンカー",
    "ملجأ العزل",
    "Bunker di isolamento"
  ],
  [
    "Isolation is enabled but this location runs on the HOST (the sandbox is unavailable or this folder is outside it).",
    "已启用隔离，但此位置运行在主机上（沙箱不可用或此文件夹在其外部）。",
    "격리가 활성화되어 있지만 이 위치는 HOST에서 실행됩니다 (샌드박스는 사용할 수 없거나 이 폴더가 그 밖에 있음).",
    "アイソレーションは有効ですが、この場所はホストで実行されます（サンドボックスは利用できないか、このフォルダーはサンドボックスの外にあります）。",
    "العزل مفعل لكن هذا الموقع يعمل على المضيف (الصندوق الرملي غير متاح أو هذا المجلد خارجه).",
    "L'isolamento è abilitato ma questa posizione viene eseguita sull'HOST (la sandbox non è disponibile o questa cartella è al di fuori di essa)."
  ],
  [
    "It can read, search, edit and create files and run commands there.",
    "它可以在此处读取、搜索、编辑和创建文件，并运行命令。",
    "여기에서 파일을 읽고, 검색하고, 편집하고, 생성하며 명령을 실행할 수 있습니다.",
    "ここでファイルを読み取り、検索、編集、作成し、コマンドを実行できます。",
    "يمكنه قراءة الملفات والبحث فيها وتحريرها وإنشاؤها وتشغيل الأوامر هناك.",
    "Può leggere, cercare, modificare e creare file ed eseguire comandi lì."
  ],
  [
    "it there and click",
    "它在那里并点击",
    "거기에서 클릭하세요",
    "そこにあってクリックします",
    "انقر هناك",
    "irci lì e cliccare"
  ],
  [
    "item",
    "项目",
    "항목",
    "アイテム",
    "عنصر",
    "elemento"
  ],
  [
    "Job description",
    "职位描述",
    "직무 설명",
    "職務内容",
    "وصف الوظيفة",
    "Descrizione del lavoro"
  ],
  [
    "JSON object identifying the KVM node:",
    "识别 KVM 节点的 JSON 对象：",
    "KVM 노드를 식별하는 JSON 객체:",
    "KVMノードを識別するJSONオブジェクト:",
    "كائن JSON يحدد عقدة KVM:",
    "Oggetto JSON che identifica il nodo KVM:"
  ],
  [
    "JSON object of action-specific params. screenshot: {} — type: {\"text\": string} —",
    "JSON 对象的动作特定参数。截图：{} — 类型：{\"text\": string} —",
    "액션별 매개변수의 JSON 객체. 스크린샷: {} — 타입: {\"text\": 문자열} —",
    "アクション固有のパラメータのJSONオブジェクト。スクリーンショット: {} — タイプ: {\"text\": string} —",
    "كائن JSON للمعلمات الخاصة بالإجراء. لقطة الشاشة: {} — النوع: {\"text\": string} —",
    "Oggetto JSON di parametri specifici per l'azione. screenshot: {} — tipo: {\"text\": string} —"
  ],
  [
    "Just chat",
    "仅聊天",
    "그냥 채팅",
    "ただチャット",
    "فقط دردشة",
    "Solo chat"
  ],
  [
    "k ctx",
    "k 上下文",
    "k 컨텍스트",
    "k ctx",
    "k ctx",
    "k ctx"
  ],
  [
    "Kanban",
    "看板",
    "칸반",
    "カンバン",
    "كانبان",
    "Kanban"
  ],
  [
    "Keep",
    "保持",
    "보관",
    "保持",
    "احتفظ",
    "Tieni"
  ],
  [
    "Keep everything on this device only",
    "仅在此设备上保留所有内容",
    "이 장치에만 모든 항목 저장",
    "このデバイスだけにすべて保持",
    "احتفظ بكل شيء على هذا الجهاز فقط",
    "Conserva tutto solo su questo dispositivo"
  ],
  [
    "Keep frame",
    "保持帧",
    "프레임 유지",
    "フレームを保持",
    "احتفظ بالإطار",
    "Mantieni il frame"
  ],
  [
    "key (optional, e.g. build_command)",
    "键（可选，例如 build_command）",
    "키 (선택 사항, 예: build_command)",
    "キー（オプション、例: build_command）",
    "المفتاح (اختياري، مثال: build_command)",
    "chiave (opzionale, es. build_command)"
  ],
  [
    "Key name to press, e.g. 'Enter' or 'Escape'.",
    "要按的键名，例如 'Enter' 或 'Escape'",
    "누를 키 이름, 예: 'Enter' 또는 'Escape'.",
    "押すキーの名前、例: 'Enter' または 'Escape'",
    "اسم المفتاح للضغط، مثال: 'Enter' أو 'Escape'.",
    "Nome del tasto da premere, es. 'Invio' o 'Esc'."
  ],
  [
    "keys: {\"combo\": string} (e.g. \"ctrl+alt+del\") — mouse: {\"x\"?: number, \"y\"?: number,",
    "keys: {\"combo\": string}（例如 \"ctrl+alt+del\"）— 鼠标: {\"x\"?: number, \"y\"?: number,\"}",
    "키: {\"combo\": 문자열} (예: \"ctrl+alt+del\") — 마우스: {\"x\"?: 숫자, \"y\"?: 숫자}",
    "キー: {\"combo\": 文字列} (例: \"ctrl+alt+del\") — マウス: {\"x\"?: 数字, \"y\"?: 数字}",
    "المفاتيح: {\"combo\": string} (مثال: \"ctrl+alt+del\") — الفأرة: {\"x\"?: number, \"y\"?: number}",
    "tasti: {\"combo\": string} (es. \"ctrl+alt+canc\") — mouse: {\"x\"?: numero, \"y\"?: numero}"
  ],
  [
    "Keywords to look up (e.g. 'build command', 'auth flow'). Empty = most recent.",
    "要查找的关键字（例如 'build command', 'auth flow'）。为空=最近使用",
    "찾아볼 키워드 (예: '빌드 명령', '인증 흐름'). 비어 있음 = 가장 최근 항목.",
    "調べるキーワード（例: 'build command', 'auth flow'）。空欄 = 最近のもの",
    "الكلمات المفتاحية للبحث (مثال: 'build command'، 'auth flow'). فارغ = الأحدث.",
    "Parole chiave da cercare (es. 'comando build', 'flusso di autenticazione'). Vuoto = più recente."
  ],
  [
    "Kill the inference server highlighted in the list.",
    "杀死列表中突出显示的推理服务器。",
    "목록에서 강조 표시된 추론 서버 종료.",
    "リストでハイライトされた推論サーバーを終了",
    "قتل خادم الاستدلال المظلل في القائمة.",
    "Uccidi il server di inferenza evidenziato nella lista."
  ],
  [
    "KIMI",
    "KIMI",
    "KIMI",
    "KIMI",
    "كيمي",
    "KIMI"
  ],
  [
    "kind",
    "友好",
    "친절한",
    "親切",
    "لطيف",
    "gentile"
  ],
  [
    "knowledge — NOT transient chatter. Provide a short 'key' to UPDATE a known",
    "知识——不是短暂的闲聊。提供一个简短的“关键”来更新已知信息。",
    "지식 — 일시적인 잡담이 아님. 알려진 내용을 업데이트하기 위한 짧은 '키'를 제공하십시오.",
    "知識 — 一時的なおしゃべりではない。既知のものを更新するための短い「鍵」を提供する",
    "المعرفة — ليست ثرثرة عابرة. قدم 'مفتاحًا' قصيرًا لتحديث ما هو معروف",
    "conoscenza — NON chiacchiere transitorie. Fornisci una breve 'chiave' per AGGIORNARE un conoscenza nota"
  ],
  [
    "KV cache ≈ {0} GB on top of the weights (30B-class estimate). Lower this if a model crashes on load.",
    "KV缓存 ≈ {0} GB，位于权重之上（30B级别估计）。如果模型在加载时崩溃，请将其降低。",
    "KV 캐시는 가중치 위에 약 {0} GB입니다(30B급 추정). 모델이 로드 중에 충돌하면 이를 낮추십시오.",
    "KVキャッシュ ≈ {0} GB（重みの上にのせる、30Bクラスの推定）。モデルのロード中にクラッシュする場合はこれを減らしてください。",
    "ذاكرة التخزين المؤقت KV ≈ {0} جيجابايت بالإضافة إلى الأوزان (تقدير لفئة 30B). قلل هذا إذا تعطل النموذج عند التحميل.",
    "Cache KV ≈ {0} GB oltre ai pesi (stima per classe 30B). Riducilo se un modello si blocca al caricamento."
  ],
  [
    "LAN",
    "局域网",
    "LAN",
    "LAN",
    "شبكة محلية",
    "LAN"
  ],
  [
    "LAN:",
    "局域网：",
    "LAN:",
    "LAN:",
    "شبكة محلية:",
    "LAN:"
  ],
  [
    "Last used",
    "上次使用",
    "마지막 사용",
    "最終使用",
    "آخر استخدام",
    "Ultimo utilizzo"
  ],
  [
    "Later",
    "之后",
    "나중에",
    "後で",
    "لاحقًا",
    "Più tardi"
  ],
  [
    "latest browser_snapshot. Snapshot first to get the index.",
    "最新的浏览器快照。先快照以获取索引。",
    "최신 브라우저 스냅샷. 인덱스를 얻으려면 먼저 스냅샷.",
    "最新のブラウザスナップショット。インデックスを取得するにはまずスナップショットを作成する。",
    "أحدث لقطة للمستعرض. قم بالتقاط اللقطة أولاً للحصول على الفهرس.",
    "ultimo snapshot del browser. Effettua prima lo snapshot per ottenere l'indice."
  ],
  [
    "Launching WSL install — accept the UAC prompt, then reboot…",
    "启动 WSL 安装 — 接受 UAC 提示，然后重启…",
    "WSL 설치 시작 — UAC 프롬프트를 수락한 후 재부팅…",
    "WSLインストールを開始 — UACプロンプトを承認し、その後再起動…",
    "بدء تثبيت WSL — اقبل مطالبة UAC، ثم أعد التشغيل…",
    "Avvio dell'installazione di WSL — accetta il prompt UAC, poi riavvia…"
  ],
  [
    "leader",
    "领导者",
    "리더",
    "リーダー",
    "القائد",
    "LEADER"
  ],
  [
    "LEADER",
    "领导",
    "리더",
    "リーダー",
    "قائد",
    "LEADER"
  ],
  [
    "Leads a sub-team — dispatches to its own members",
    "领导一个子团队 — 分配任务给自己的成员",
    "하위 팀을 이끈다 — 자체 구성원에게 할당",
    "サブチームを率いる — 自分のメンバーに割り当てる",
    "يقود فريقًا فرعيًا — يرسل المهام إلى أعضائه الخاصين",
    "Guida un sotto-team — invia compiti ai propri membri"
  ],
  [
    "leads the team, plans, and dispatches work to specialists",
    "领导团队，计划并将工作分配给专家",
    "팀을 이끌고, 계획하며, 전문가들에게 업무를 배분합니다",
    "チームを率い、計画を立て、専門家に仕事を割り振る",
    "يقود الفريق، يخطط، ويوزع العمل على المتخصصين",
    "Guida il team, pianifica e assegna il lavoro agli specialisti"
  ],
  [
    "Leads the whole team — it always dispatches. (Not an Agent/Leader choice; that's only for the other agents.)",
    "领导整个团队 — 它总是分配任务。（不是代理/领导选择；那只是给其他代理的。）",
    "전체 팀을 이끈다 — 항상 할당을 수행함. (에이전트/리더 선택이 아님; 이는 다른 에이전트에게만 해당됨.)",
    "チーム全体を率いる — 常に割り当てを行う。（エージェント／リーダーの選択ではない；それは他のエージェント用のみ）",
    "يقود الفريق بأكمله — دائماً يرسل المهام. (ليس خيارًا للوكيل/القائد؛ هذا فقط للوكالات الأخرى.)",
    "Guida l'intero team — invia sempre compiti. (Non è una scelta Agente/Leader; questo vale solo per gli altri agenti.)"
  ],
  [
    "Legacy templates",
    "传统模板",
    "레거시 템플릿",
    "レガシーテンプレート",
    "قوالب الإرث",
    "Template legacy"
  ],
  [
    "let agents see + operate a remote computer through a NanoKVM/PiKVM (kvm_node tool)",
    "让代理通过 NanoKVM/PiKVM（kvm_node 工具）查看并操作远程计算机",
    "에이전트가 NanoKVM/PiKVM(kvm_node 도구)을 통해 원격 컴퓨터를 보고 조작하게 합니다",
    "エージェントにNanoKVM/PiKVM（kvm_nodeツール）を通じてリモートコンピュータを見せ、操作させる",
    "يسمح للوكلاء برؤية وتشغيل جهاز كمبيوتر عن بُعد من خلال NanoKVM/PiKVM (أداة kvm_node)",
    "consenti agli agenti di vedere e operare un computer remoto tramite NanoKVM/PiKVM (strumento kvm_node)"
  ],
  [
    "Let agents use remote devices",
    "让代理使用远程设备",
    "에이전트가 원격 장치를 사용하게 합니다",
    "エージェントにリモートデバイスを使わせる",
    "يسمح للوكلاء باستخدام الأجهزة عن بُعد",
    "Consenti agli agenti di usare dispositivi remoti"
  ],
  [
    "Let OWLLM size the context to your GPU — bigger card = bigger window (recommended).",
    "让 OWLLM 根据你的 GPU 调整上下文大小 — 显卡越大 = 窗口越大（推荐）。",
    "OWLLM이 GPU에 맞게 컨텍스트 크기를 조정하게 둔다 — 큰 카드 = 더 큰 창 (권장).",
    "OWLLMがコンテキストをあなたのGPUに合わせてサイズ調整します — 大きなカード = 大きなウィンドウ（推奨）。",
    "دع OWLLM يحدد حجم السياق لبطاقتك الرسومية — بطاقة أكبر = نافذة أكبر (موصى بها).",
    "Lascia che OWLLM ridimensioni il contesto in base alla tua GPU — scheda più grande = finestra più grande (consigliato)."
  ],
  [
    "Let this project's agents run OUTSIDE the sandbox. Use only for projects you trust.",
    "让该项目的代理在沙箱之外运行。仅对你信任的项目使用。",
    "이 프로젝트의 에이전트를 샌드박스 외부에서 실행하게 합니다. 신뢰할 수 있는 프로젝트에만 사용하세요.",
    "このプロジェクトのエージェントにサンドボックス外で実行させる。信頼できるプロジェクトのみで使用すること。",
    "يسمح لوكلاء هذا المشروع بالتشغيل خارج الصندوق الرملي. استخدمه فقط للمشاريع التي تثق بها.",
    "Consenti agli agenti di questo progetto di eseguire FUORI dalla sandbox. Usare solo per progetti di cui ti fidi."
  ],
  [
    "Lets your other OwLLM machines pair with this one. Its address is shared to them automatically through your GitHub vault — nothing to type.",
    "让你的其他 OwLLM 机器与这台配对。它的地址会通过你的 GitHub 保管库自动共享给它们——无需输入任何内容。",
    "다른 OwLLM 기기들이 이 기기와 페어링하도록 하세요. 주소는 GitHub 금고를 통해 자동으로 공유되므로 입력할 필요가 없습니다.",
    "他のOwLLMマシンがこれとペアリングできるようにします。そのアドレスは自動的にGitHubボールトを通じて共有されます — 入力する必要はありません。",
    "يسمح لآلات OwLLM الأخرى بالاقتران مع هذه الآلة. يتم مشاركة عنوانها معهم تلقائيًا من خلال خزنة GitHub الخاصة بك — لا حاجة لكتابة أي شيء.",
    "Permette alle tue altre macchine OwLLM di collegarsi a questa. Il suo indirizzo viene condiviso automaticamente con loro tramite il tuo vault di GitHub — niente da digitare."
  ],
  [
    "Light",
    "轻量",
    "Light",
    "ライト",
    "خفيف",
    "Luce"
  ],
  [
    "Likely won't load",
    "可能无法加载",
    "아마도 로드되지 않을 것입니다",
    "おそらくロードされません",
    "من غير المرجح أن يتم التحميل",
    "Probabilmente non si caricherà"
  ],
  [
    "likes",
    "喜欢",
    "좋아요",
    "いいね",
    "يعجب",
    "piace"
  ],
  [
    "LINE",
    "LINE",
    "LINE",
    "LINE",
    "خط",
    "LINEA"
  ],
  [
    "Linux (WSL):",
    "Linux (WSL)：",
    "Linux (WSL):",
    "Linux (WSL):",
    "لينكس (WSL):",
    "Linux (WSL):"
  ],
  [
    "Linux:",
    "Linux：",
    "Linux:",
    "Linux:",
    "لينكس:",
    "Linux:"
  ],
  [
    "list",
    "列表",
    "목록",
    "リスト",
    "قائمة",
    "elenco"
  ],
  [
    "List every SKILL pack available to you (name + one-line description).",
    "列出你可用的每个 SKILL 套件（名称+一行描述）。",
    "사용 가능한 모든 SKILL 팩을 나열합니다 (이름 + 한줄 설명).",
    "利用可能なすべてのSKILLパックを一覧表示（名前＋1行の説明）",
    "سرد كل حزمة مهارات متاحة لك (الاسم + وصف من سطر واحد).",
    "Elenca ogni pacchetto SKILL disponibile per te (nome + descrizione in una riga)."
  ],
  [
    "List the entries (files + subfolders) of a directory.",
    "列出目录的条目（文件+子文件夹）。",
    "디렉토리의 항목(파일 + 하위폴더)을 나열합니다.",
    "ディレクトリのエントリ（ファイル+サブフォルダ）を一覧表示",
    "سرد المدخلات (الملفات + المجلدات الفرعية) لدليل.",
    "Elenca le voci (file + sottocartelle) di una directory."
  ],
  [
    "List view",
    "列表视图",
    "목록 보기",
    "リスト表示",
    "عرض القائمة",
    "Visualizzazione elenco"
  ],
  [
    "Listening on {0} — point your tunnel at this port; webhook callback URL = <tunnel>/whatsapp.",
    "正在监听 {0} — 将你的隧道指向此端口；webhook 回调 URL = <tunnel>/whatsapp。",
    "{0}에서 수신 중 — 이 포트로 터널을 지정하세요; 웹후크 콜백 URL = <tunnel>/whatsapp.",
    "{0} でリッスン中 — このポートにトンネルを向けてください; webhook コールバック URL = <tunnel>/whatsapp。",
    "الاستماع على {0} — وجه نفقك إلى هذا المنفذ؛ عنوان URL لرد الاتصال بالويب هوك = <tunnel>/whatsapp.",
    "Ascoltando su {0} — punta il tuo tunnel su questa porta; URL di callback webhook = <tunnel>/whatsapp."
  ],
  [
    "LIVE",
    "直播",
    "LIVE",
    "ライブ",
    "مباشر",
    "DAL VIVO"
  ],
  [
    "live — refine the brief in chat and it updates",
    "实时 — 在聊天中完善简报，它会更新",
    "live — 채팅에서 브리핑을 수정하면 업데이트됩니다",
    "live — チャットでブリーフを調整すると更新されます",
    "live — صَوِّر الملخص في الدردشة وسيتم تحديثه",
    "live — affina il brief in chat e si aggiorna"
  ],
  [
    "Llama 3.x",
    "Llama 3.x",
    "라마 3.x",
    "Llama 3.x",
    "Llama 3.x",
    "Llama 3.x"
  ],
  [
    "llama-server still warming up ·",
    "llama-server 仍在启动中 ·",
    "llama-server가 아직 준비 중입니다 ·",
    "llama-server はまだウォームアップ中 ·",
    "llama-server لا يزال في طور التسخين ·",
    "llama-server si sta ancora riscaldando ·"
  ],
  [
    "LLM-tuned search — returns clean text instead of raw HTML. Free 1000 q/mo, no card.",
    "LLM 调优搜索 — 返回干净文本而非原始 HTML。每月免费 1000 次查询，无需信用卡。",
    "LLM 조정 검색 — 원시 HTML 대신 깨끗한 텍스트를 반환합니다. 무료 1000회/월, 카드 필요 없음.",
    "LLM チューニング検索 — 生の HTML ではなくクリーンなテキストを返します。無料で月1000クエリ、カード不要。",
    "البحث المهيأ بواسطة LLM — يُرجع نصًا نظيفًا بدلاً من HTML الخام. مجاني 1000 استعلام/شهر، بدون بطاقة.",
    "Ricerca ottimizzata con LLM — restituisce testo pulito invece del HTML grezzo. 1000 query gratuite al mese, senza carta."
  ],
  [
    "Load",
    "加载",
    "불러오기",
    "読み込み",
    "تحميل",
    "Carica"
  ],
  [
    "Load into the form to update (leave password blank to keep it)",
    "加载到表单以更新（留空密码以保持不变）",
    "업데이트하려면 폼에 불러오기(비밀번호는 그대로 두려면 빈칸으로 둠)",
    "フォームに読み込むと更新されます（パスワードは空欄のままにすると保持されます）",
    "تحميل في النموذج للتحديث (اترك كلمة المرور فارغة للاحتفاظ بها)",
    "Carica nel modulo per aggiornare (lasciare la password vuota per mantenerla)"
  ],
  [
    "Load the FULL instructions for one SKILL pack into context, by name.",
    "将一个技能包的完整说明按名称加载到上下文中。",
    "한 SKILL 팩의 전체 지침을 이름으로 컨텍스트에 불러오기.",
    "1つのSKILLパックの完全な指示を名前でコンテキストに読み込みます。",
    "تحميل التعليمات الكاملة لحزمة مهارة واحدة إلى السياق، بالاسم.",
    "Carica le ISTRUZIONI COMPLETE di un pacchetto ABILITÀ nel contesto, per nome."
  ],
  [
    "Loading",
    "正在加载",
    "불러오는 중",
    "読み込み中",
    "جارٍ التحميل",
    "Caricamento"
  ],
  [
    "Loading 3D graph…",
    "正在加载3D图表…",
    "3D 그래프 로딩 중…",
    "3Dグラフを読み込み中…",
    "جارٍ تحميل الرسم البياني ثلاثي الأبعاد…",
    "Caricamento grafico 3D…"
  ],
  [
    "Loading file list…",
    "正在加载文件列表…",
    "파일 목록 로딩 중…",
    "ファイルリストを読み込み中…",
    "جارٍ تحميل قائمة الملفات…",
    "Caricamento elenco file…"
  ],
  [
    "Loading model into VRAM — click sends as soon as ready",
    "将模型加载到显存中——准备好后点击发送",
    "모델을 VRAM에 로딩 중 — 준비되면 클릭으로 전송",
    "モデルをVRAMに読み込み中 — 準備ができたらクリックして送信",
    "جارٍ تحميل النموذج إلى VRAM — انقر للإرسال حالما يصبح جاهزًا",
    "Caricamento modello nella VRAM — clicca per inviare non appena pronto"
  ],
  [
    "Loading recommended models…",
    "正在加载推荐模型…",
    "추천 모델 로딩 중…",
    "推奨モデルを読み込み中…",
    "جارٍ تحميل النماذج الموصى بها…",
    "Caricamento modelli consigliati…"
  ],
  [
    "Loading the team workbench…",
    "正在加载团队工作台…",
    "팀 작업대 로딩 중…",
    "チーム作業台を読み込み中…",
    "جارٍ تحميل منصة عمل الفريق…",
    "Caricamento banco di lavoro del team…"
  ],
  [
    "loading…",
    "加载中…",
    "로딩 중…",
    "読み込み中…",
    "جارٍ التحميل…",
    "Caricamento…"
  ],
  [
    "Loading…",
    "加载中…",
    "로딩 중…",
    "読み込み中…",
    "جارٍ التحميل…",
    "Caricamento…"
  ],
  [
    "Loads the target model in transformers (HF format, fp16 on CUDA).",
    "在 transformers 中加载目标模型（HF 格式，CUDA 上的 fp16）。",
    "Transformers에서 대상 모델 로드 (HF 형식, CUDA에서 fp16).",
    "トランスフォーマーでターゲットモデルをロードします（HF形式、CUDAでfp16）。",
    "يقوم بتحميل النموذج المستهدف في المحولات (صيغة HF، fp16 على CUDA).",
    "Carica il modello di destinazione in transformers (formato HF, fp16 su CUDA)."
  ],
  [
    "local",
    "本地",
    "로컬",
    "ローカル",
    "محلي",
    "LOCALE"
  ],
  [
    "LOCAL",
    "本地",
    "로컬",
    "ローカル",
    "محلي",
    "LOCALE"
  ],
  [
    "Local (this PC)",
    "本地（此电脑）",
    "로컬 (이 PC)",
    "ローカル（このPC）",
    "محلي (هذا الكمبيوتر)",
    "Locale (questo PC)"
  ],
  [
    "local folder key (e.g. myteam)",
    "本地文件夹键（例如 myteam）",
    "로컬 폴더 키 (예: myteam)",
    "ローカルフォルダキー（例：myteam）",
    "مفتاح المجلد المحلي (مثلاً myteam)",
    "Chiave della cartella locale (es. myteam)"
  ],
  [
    "Local generation speed (tokens per second)",
    "本地生成速度（每秒令牌数）",
    "로컬 생성 속도 (초당 토큰)",
    "ローカル生成速度（トークン／秒）",
    "سرعة التوليد المحلي (عدد الرموز في الثانية)",
    "Velocità di generazione locale (token al secondo)"
  ],
  [
    "Local git ops — log, diff, blame, branches. Edit --repository to your repo.",
    "本地Git操作——日志、差异、责任、分支。编辑 --repository 到你的仓库。",
    "로컬 git 작업 — 로그, 차이, 책임자 표시, 브랜치. --repository를 편집하여 당신의 저장소 사용.",
    "ローカルgit操作 — ログ、差分、ブレーム、ブランチ。--repositoryを自分のリポジトリに編集してください。",
    "العمليات المحلية في Git — السجل، الفرق، اللوم، الفروع. عدل --repository ليشير إلى مستودعك.",
    "Operazioni git locali — log, diff, blame, branch. Modifica --repository per il tuo repository."
  ],
  [
    "Local model is still warming up",
    "本地模型仍在预热中",
    "로컬 모델이 아직 준비 중입니다",
    "ローカルモデルはまだウォームアップ中です",
    "النموذج المحلي لا يزال في مرحلة التسخين",
    "Il modello locale si sta ancora riscaldando"
  ],
  [
    "Local Models",
    "本地模型",
    "로컬 모델",
    "ローカルモデル",
    "النماذج المحلية",
    "Modelli locali"
  ],
  [
    "Local SQLite read/write + schema inspection. Edit --db-path to your DB.",
    "本地 SQLite 读写 + 模式检查。编辑 --db-path 到你的数据库。",
    "로컬 SQLite 읽기/쓰기 + 스키마 검사. --db-path를 수정하여 데이터베이스 지정.",
    "ローカルSQLite読み書き + スキーマ確認。DBを編集するには --db-path を使用。",
    "قراءة/كتابة SQLite المحلية + فحص المخطط. حرر --db-path إلى قاعدة بياناتك.",
    "Lettura/scrittura SQLite locale + ispezione dello schema. Modifica --db-path per il tuo DB."
  ],
  [
    "local support assistant",
    "本地支持助手",
    "로컬 지원 어시스턴트",
    "ローカルサポートアシスタント",
    "مساعد الدعم المحلي",
    "assistente di supporto locale"
  ],
  [
    "log",
    "日志",
    "로그",
    "ログ",
    "سجل",
    "registro"
  ],
  [
    "Login sync failed: {0}",
    "登录同步失败：{0}",
    "로그인 동기화 실패: {0}",
    "ログインの同期に失敗しました: {0}",
    "فشل مزامنة تسجيل الدخول: {0}",
    "Sincronizzazione accesso fallita: {0}"
  ],
  [
    "logs",
    "日志",
    "로그들",
    "ログ",
    "سجلات",
    "Registri"
  ],
  [
    "Logs",
    "日志",
    "로그",
    "ログ",
    "سجلات",
    "Registri"
  ],
  [
    "Logs (",
    "日志 (",
    "로그들 (",
    "ログ (",
    "سجلات (",
    "Registri ("
  ],
  [
    "LoRA",
    "LoRA",
    "로라",
    "LoRA",
    "LoRA",
    "LoRA"
  ],
  [
    "Loss",
    "损失",
    "손실",
    "損失",
    "خسارة",
    "Perdita"
  ],
  [
    "LR",
    "学习率",
    "학습률",
    "学習率",
    "LR",
    "LR"
  ],
  [
    "macOS:",
    "macOS：",
    "macOS:",
    "macOS:",
    "macOS:",
    "macOS:"
  ],
  [
    "main",
    "主程序",
    "메인",
    "メイン",
    "الرئيسية",
    "principale"
  ],
  [
    "Make a change to enable saving",
    "进行更改以启用保存",
    "저장을 활성화하도록 변경",
    "保存を有効にするために変更を加える",
    "قم بإجراء تغيير لتمكين الحفظ",
    "Apporta una modifica per abilitare il salvataggio"
  ],
  [
    "Manage →",
    "管理 →",
    "관리 →",
    "管理 →",
    "إدارة →",
    "Gestisci →"
  ],
  [
    "Manage sync / account",
    "管理同步 / 账户",
    "동기화 / 계정 관리",
    "同期/アカウントを管理",
    "إدارة المزامنة / الحساب",
    "Gestisci sincronizzazione / account"
  ],
  [
    "Mark done",
    "标记为完成",
    "완료로 표시",
    "完了としてマーク",
    "وضع علامة تم",
    "Segna come completato"
  ],
  [
    "matching {path, line, text} hits. Skips .git / node_modules /",
    "匹配 {路径, 行, 文本} 命中。跳过 .git / node_modules /",
    "{path, line, text} 일치 항목. .git / node_modules /는 건너뜁니다.",
    "{path, line, text} の一致ヒット。 .git / node_modules / はスキップ",
    "مطابقة ضربات {المسار، السطر، النص}. يتجاهل .git / node_modules /",
    "corrispondenza {percorso, riga, testo} risultati. Ignora .git / node_modules /"
  ],
  [
    "Max characters per chunk",
    "每个块的最大字符数",
    "청크당 최대 문자 수",
    "チャンクごとの最大文字数",
    "الحد الأقصى لعدد الأحرف لكل جزء",
    "Caratteri massimi per frammento"
  ],
  [
    "Max chunks",
    "最大块数",
    "최대 청크 수",
    "最大チャンク数",
    "أقصى عدد من الأجزاء",
    "Frammenti massimi"
  ],
  [
    "Max entries to return (1-50, default 8).",
    "返回的最大条目数 (1-50，默认 8)",
    "반환할 최대 항목 수 (1-50, 기본값 8).",
    "返す最大エントリ数（1-50、デフォルト8）。",
    "الحد الأقصى للإدخالات للاسترجاع (1-50، الافتراضي 8).",
    "Massimo numero di voci da restituire (1-50, predefinito 8)."
  ],
  [
    "Max turns:",
    "Max 转换：",
    "최대 턴 수:",
    "最大ターン数：",
    "الحد الأقصى للدورات:",
    "Massimo numero di turni:"
  ],
  [
    "Maximize / restore",
    "最大化 / 恢复",
    "최대화 / 복원",
    "最大化 / 復元",
    "تكبير / استعادة",
    "Massimizza / ripristina"
  ],
  [
    "Maybe later",
    "也许稍后",
    "나중에",
    "あとで",
    "ربما لاحقًا",
    "Forse più tardi"
  ],
  [
    "MCP NEEDED",
    "需要 MCP",
    "MCP 필요",
    "MCP 必須",
    "MCP مطلوب",
    "MCP NECESSARIO"
  ],
  [
    "MCP PACK",
    "MCP 包",
    "MCP 패키지",
    "MCP パック",
    "حزمة MCP",
    "PACCHETTO MCP"
  ],
  [
    "MCP servers are subprocess tool providers (typically npm packages run via npx). Two layers:",
    "MCP 服务器是子进程工具提供者（通常是通过 npx 运行的 npm 包）。两层：",
    "MCP 서버는 하위 프로세스 도구 제공자(일반적으로 npx를 통해 실행되는 npm 패키지)입니다. 두 단계:",
    "MCP サーバーはサブプロセスツール提供者（通常は npx 経由で実行される npm パッケージ）です。2 層構造：",
    "خوادم MCP هي مزودو أدوات للعمليات الفرعية (عادة حزم npm تُشغل عبر npx). طبقتان:",
    "I server MCP sono fornitori di strumenti sotto-processo (tipicamente pacchetti npm eseguiti tramite npx). Due livelli:"
  ],
  [
    "MCP tool {0}",
    "MCP 工具 {0}",
    "MCP 도구 {0}",
    "MCP ツール {0}",
    "أداة MCP {0}",
    "Strumento MCP {0}"
  ],
  [
    "MCP tools",
    "MCP 工具",
    "MCP 도구들",
    "MCP ツール",
    "أدوات MCP",
    "Strumenti MCP"
  ],
  [
    "MCP tools are OFF — agents see only built-in tools. Click to turn MCP tools back on.",
    "MCP 工具已关闭 — 代理只能看到内置工具。点击以重新开启 MCP 工具。",
    "MCP 도구가 꺼져 있습니다 — 에이전트는 내장 도구만 볼 수 있습니다. MCP 도구를 다시 켜려면 클릭하세요.",
    "MCPツールはオフです — エージェントは組み込みツールのみを見ます。クリックしてMCPツールを再度オンにしてください。",
    "أدوات MCP متوقفة — العملاء يرون الأدوات المدمجة فقط. انقر لتشغيل أدوات MCP مرة أخرى.",
    "Gli strumenti MCP sono SPENTI — gli agenti vedono solo gli strumenti integrati. Clicca per riattivare gli strumenti MCP."
  ],
  [
    "MCP tools are ON — advertised to every agent. Click to turn all MCP tools off (local tools stay).",
    "MCP 工具已开启 — 向每个代理宣传。点击以关闭所有 MCP 工具（本地工具保持开启）。",
    "MCP 도구가 켜져 있습니다 — 모든 에이전트에게 광고됨. 클릭하여 모든 MCP 도구를 끕니다(로컬 도구는 그대로 유지됨). ",
    "MCPツールはオンです — 全てのエージェントに宣伝されます。クリックしてすべてのMCPツールをオフにしてください（ローカルツールはそのまま）。",
    "أدوات MCP مفعلة — معلنة لكل عميل. انقر لإيقاف جميع أدوات MCP (الأدوات المحلية ستبقى).",
    "Gli strumenti MCP sono ATTIVI — pubblicizzati a tutti gli agenti. Clicca per spegnere tutti gli strumenti MCP (gli strumenti locali rimangono)."
  ],
  [
    "MCP tools OFF",
    "MCP 工具关闭",
    "MCP 도구 꺼짐",
    "MCP ツール OFF",
    "أدوات MCP متوقفة",
    "Strumenti MCP DISATTIVATI"
  ],
  [
    "MCP tools ON/OFF",
    "MCP 工具 开启/关闭",
    "MCP 도구 켬/끔",
    "MCP ツール ON/OFF",
    "أدوات MCP تشغيل/إيقاف",
    "Strumenti MCP ATTIVI/DISATTIVI"
  ],
  [
    "mcp:",
    "mcp：",
    "mcp:",
    "mcp:",
    "mcp:",
    "mcp:"
  ],
  [
    "mcp:<server>:<tool>",
    "mcp:<服务器>:<工具>",
    "mcp:<서버>:<도구>",
    "mcp:<サーバー>:<ツール>",
    "mcp:<الخادم>:<الأداة>",
    "mcp:<server>:<tool>"
  ],
  [
    "memory_context({0})",
    "memory_context({0})",
    "memory_context({0})",
    "memory_context({0})",
    "memory_context({0})",
    "memory_context({0})"
  ],
  [
    "memory_search). Returns the stored content, or nothing if that key is unset.",
    "memory_search)。返回存储的内容，如果该键未设置则返回空。",
    "memory_search). 저장된 내용을 반환하며, 해당 키가 설정되지 않은 경우 아무것도 반환하지 않습니다.",
    "memory_search). 保存された内容を返します。キーが設定されていない場合は何も返しません。",
    "memory_search). يعيد المحتوى المخزن، أو لا شيء إذا لم يتم ضبط هذا المفتاح.",
    "memory_search). Restituisce il contenuto memorizzato, o nulla se quella chiave non è impostata."
  ],
  [
    "Merge",
    "合并",
    "병합",
    "マージ",
    "دمج",
    "Unisci"
  ],
  [
    "Merge this page's worktree back into {0}",
    "将此页面的工作树合并回 {0}",
    "이 페이지의 작업 트리를 {0}으로 다시 병합합니다",
    "このページのワークツリーを {0} にマージします",
    "دمج شجرة عمل هذه الصفحة مرة أخرى في {0}",
    "Unisci l'albero di lavoro di questa pagina in {0}"
  ],
  [
    "Message Content",
    "消息内容",
    "메시지 내용",
    "メッセージコンテンツ",
    "محتوى الرسالة",
    "Contenuto del Messaggio"
  ],
  [
    "Message the second agent… (same workspace, its own conversation & model)",
    "给第二个代理发送消息…（相同工作区，其自己的对话和模型）",
    "두 번째 에이전트에게 메시지 보내기… (같은 작업 공간, 자체 대화 및 모델)",
    "2番目のエージェントにメッセージを送る…（同じワークスペース、独自の会話とモデル）",
    "أرسل رسالة إلى الوكيل الثاني… (نفس مساحة العمل، محادثته الخاصة والنموذج الخاص به)",
    "Messaggia il secondo agente… (stesso spazio di lavoro, conversazione e modello propri)"
  ],
  [
    "Message… (paste or attach an image, Enter to send, Shift+Enter for newline)",
    "发送消息…（粘贴或附加图片，按回车发送，Shift+回车换行）",
    "메시지 보내기… (이미지를 붙여넣거나 첨부, Enter를 눌러 전송, Shift+Enter로 줄바꿈)",
    "メッセージ…（画像を貼り付けるか添付、送信にはEnter、改行にはShift+Enter）",
    "رسالة… (الصق أو أرفق صورة، اضغط Enter للإرسال، Shift+Enter لسطر جديد)",
    "Messaggia… (incolla o allega un'immagine, Invio per inviare, Shift+Invio per nuova riga)"
  ],
  [
    "message.channels",
    "message.channels",
    "message.channels",
    "message.channels",
    "message.channels",
    "message.channels"
  ],
  [
    "message.im",
    "message.im",
    "message.im",
    "message.im",
    "message.im",
    "message.im"
  ],
  [
    "Messaging API · inbound webhook · needs a public URL (tunnel)",
    "消息传递 API · 入站 webhook · 需要公共 URL（隧道）",
    "메시징 API · 인바운드 웹훅 · 공개 URL 필요 (터널)",
    "メッセージングAPI · インバウンドWebhook · 公開URLが必要（トンネル）",
    "واجهة برمجة تطبيقات المراسلة · ويب هوك وارد · يحتاج إلى عنوان URL عام (نفق)",
    "API di messaggistica · webhook in entrata · necessita di un URL pubblico (tunnel)"
  ],
  [
    "Meta Cloud API · webhook needs a public URL (cloudflared/ngrok)",
    "Meta 云 API · webhook 需要公共 URL（cloudflared/ngrok）",
    "Meta Cloud API · 웹훅은 공개 URL 필요 (cloudflared/ngrok)",
    "Meta Cloud API · Webhookには公開URLが必要（cloudflared/ngrok）",
    "واجهة برمجة تطبيقات Meta Cloud · يحتاج الويب هوك إلى عنوان URL عام (cloudflared/ngrok)",
    "API Meta Cloud · webhook necessita di un URL pubblico (cloudflared/ngrok)"
  ],
  [
    "Minimize",
    "最小化",
    "최소화",
    "最小化",
    "تصغير",
    "Minimizza"
  ],
  [
    "Mirroring your Windows logins into the sandbox…",
    "正在将您的 Windows 登录镜像到沙箱中…",
    "Windows 로그인을 샌드박스로 미러링하는 중…",
    "Windowsログインをサンドボックスにミラーリング中…",
    "عمل نسخة متماثلة لتسجيلات الدخول إلى Windows في بيئة الاختبار …",
    "Specchiando i tuoi accessi Windows nella sandbox…"
  ],
  [
    "Mission",
    "使命",
    "임무",
    "ミッション",
    "المهمة",
    "Missione"
  ],
  [
    "Mistral",
    "米斯特拉尔",
    "MISTRAL",
    "MISTRAL",
    "MISTRAL",
    "MISTRAL"
  ],
  [
    "MISTRAL",
    "米斯特拉尔",
    "미스트랄",
    "ミストラル",
    "ميسترال",
    "MISTRAL"
  ],
  [
    "Mistral / Nemo / Mixtral",
    "米斯特拉尔 / 尼莫 / Mixtral",
    "미스트랄 / 네모 / 믹스트랄",
    "Mistral / Nemo / Mixtral",
    "مِسترال / نيمو / ميكسترال",
    "Mistral / Nemo / Mixtral"
  ],
  [
    "Mobile app",
    "移动应用",
    "모바일 앱",
    "モバイルアプリ",
    "تطبيق الهاتف المحمول",
    "App mobile"
  ],
  [
    "Mode",
    "模式",
    "모드",
    "モード",
    "الوضع",
    "Modalità"
  ],
  [
    "model",
    "模型",
    "모델",
    "モデル",
    "النموذج",
    "Modello"
  ],
  [
    "Model",
    "模型",
    "모델",
    "モデル",
    "نموذج",
    "Modello"
  ],
  [
    "MODEL · this agent only",
    "模型 · 仅此代理",
    "모델 · 이 에이전트만",
    "モデル · このエージェントのみ",
    "النموذج · هذا الوكيل فقط",
    "MODELLO · solo questo agente"
  ],
  [
    "MODEL {0}",
    "模型 {0}",
    "모델 {0}",
    "MODEL {0}",
    "النموذج {0}",
    "MODELLO {0}"
  ],
  [
    "Model Forge",
    "模型锻造",
    "모델 포지",
    "Model Forge",
    "مصهر النماذج",
    "Forgia Modello"
  ],
  [
    "Model stream paused",
    "模型流已暂停",
    "모델 스트림 일시정지",
    "モデルストリーム一時停止",
    "تم إيقاف بث النموذج",
    "Stream del modello in pausa"
  ],
  [
    "Model:",
    "模型：",
    "모델:",
    "モデル:",
    "نموذج:",
    "Modello:"
  ],
  [
    "Model: {0}",
    "模型：{0}",
    "모델: {0}",
    "モデル: {0}",
    "نموذج: {0}",
    "Modello: {0}"
  ],
  [
    "Models",
    "模型列表",
    "모델들",
    "モデル",
    "النماذج",
    "Modelli"
  ],
  [
    "Models and fine-tunes are protected storage. Cleanup is split by how safe it is to remove.",
    "模型和微调是受保护的存储。清理根据其删除的安全性进行划分。",
    "모델과 파인튜닝은 보호된 저장소입니다. 정리는 제거 안전성에 따라 나뉩니다.",
    "モデルとファインチューニングは保護されたストレージです。クリーンアップは削除の安全性によって分けられます。",
    "النماذج والتعديلات الدقيقة هي تخزين محمي. يتم تنظيفها حسب مدى أمان إزالة البيانات.",
    "I modelli e le personalizzazioni fini sono archivi protetti. La pulizia è divisa in base a quanto sia sicuro rimuovere."
  ],
  [
    "models, which can't be fine-tuned directly. Pick one; it downloads automatically when you press Start.",
    "模型，不能直接微调。请选择一个；按开始时会自动下载。",
    "직접 파인튜닝할 수 없는 모델. 하나를 선택하세요; 시작 버튼을 누르면 자동으로 다운로드됩니다.",
    "直接ファインチューニングできないモデル。1つ選んでください。開始ボタンを押すと自動的にダウンロードされます。",
    "النماذج، التي لا يمكن تعديلها مباشرة. اختر واحدًا؛ يتم تنزيله تلقائيًا عند الضغط على ابدأ.",
    "modelli, che non possono essere personalizzati direttamente. Scegline uno; si scarica automaticamente quando premi Avvia."
  ],
  [
    "Modify an EXISTING file by replacing an exact substring with new",
    "通过用新的精确子字符串替换来修改现有文件",
    "기존 파일을 정확한 부분 문자열을 새 문자열로 바꿔 수정",
    "既存のファイルを、正確な部分文字列を新しいもので置き換えて修正します",
    "تعديل ملف قائم عن طريق استبدال جزء نصي محدد بجديد",
    "Modifica un file ESISTENTE sostituendo una sottostringa esatta con una nuova"
  ],
  [
    "module",
    "模块",
    "모듈",
    "モジュール",
    "وحدة",
    "modulo"
  ],
  [
    "Modules",
    "模块",
    "모듈들",
    "モジュール",
    "الوحدات",
    "Moduli"
  ],
  [
    "more",
    "更多",
    "더보기",
    "もっと",
    "المزيد",
    "altro"
  ],
  [
    "More workflows",
    "更多工作流程",
    "더 많은 워크플로",
    "さらにワークフロー",
    "المزيد من سير العمل",
    "Altri flussi di lavoro"
  ],
  [
    "Mounted in the store right now{0}",
    "目前挂载在商店中{0}",
    "현재 스토어에 장착됨{0}",
    "現在ストアにマウントされています{0}",
    "مثبت في المتجر الآن {0}",
    "Attualmente montato nel negozio {0}"
  ],
  [
    "Move down",
    "下移",
    "아래로 이동",
    "下に移動",
    "تحرك لأسفل",
    "Sposta giù"
  ],
  [
    "Move up",
    "上移",
    "위로 이동",
    "上に移動",
    "تحرك لأعلى",
    "Sposta su"
  ],
  [
    "MUST",
    "必须",
    "필수",
    "必須",
    "يجب",
    "DEVE"
  ],
  [
    "My OwLLM Devices",
    "我的 OwLLM 设备",
    "내 OwLLM 장치들",
    "私のOwLLMデバイス",
    "أجهزتي OwLLM",
    "I miei dispositivi OwLLM"
  ],
  [
    "My Research Crew",
    "我的研究团队",
    "나의 연구팀",
    "私の研究チーム",
    "طاقم البحث الخاص بي",
    "Il mio team di ricerca"
  ],
  [
    "myhost.example.com:47771 (blank = clear)",
    "myhost.example.com:47771 （空白 = 清除）",
    "myhost.example.com:47771 (비어 있음 = 초기화)",
    "myhost.example.com:47771（空白 = クリア）",
    "myhost.example.com:47771 (فارغ = مسح)",
    "myhost.example.com:47771 (vuoto = cancella)"
  ],
  [
    "name",
    "名称",
    "이름",
    "名前",
    "الاسم",
    "Nome"
  ],
  [
    "Name",
    "姓名",
    "이름",
    "名前",
    "الاسم",
    "Nome"
  ],
  [
    "Name (short, agents reference as",
    "名称（简短，代理参考为",
    "이름 (짧게, 에이전트 참조용)",
    "名前（短縮形、エージェントが参照する形で",
    "الاسم (قصير، المرجع للوكلاء كـ",
    "Nome (breve, riferimento per gli agenti come"
  ],
  [
    "Name for the new team",
    "新团队的名称",
    "새 팀의 이름",
    "新しいチームの名前",
    "الاسم للفريق الجديد",
    "Nome per il nuovo team"
  ],
  [
    "Name for your copy of '{0}':",
    "您复制的'{0}'的名称：",
    "'{0}' 복사본의 이름:",
    "'{0}' のコピーの名前:",
    "الاسم لنسختك من '{0}':",
    "Nome per la tua copia di '{0}':"
  ],
  [
    "Name for your new agent (e.g. data_wrangler):",
    "您新代理的名称（例如 data_wrangler）：",
    "새 에이전트의 이름 (예: data_wrangler):",
    "新しいエージェントの名前（例：data_wrangler）:",
    "الاسم للوكيل الجديد الخاص بك (مثال: منسق_البيانات):",
    "Nome per il tuo nuovo agente (ad esempio data_wrangler):"
  ],
  [
    "Name is required.",
    "名称为必填项。",
    "이름은 필수입니다.",
    "名前は必須です。",
    "الاسم مطلوب.",
    "Il nome è obbligatorio."
  ],
  [
    "Name on the request",
    "请求上的名称",
    "요청서상의 이름",
    "リクエスト上の名前",
    "الاسم على الطلب",
    "Nome nella richiesta"
  ],
  [
    "named after the project · origin wired · first branch pushed",
    "以项目命名 · 来源有线 · 第一个分支已推送",
    "프로젝트 이름에서 따옴 · origin wired · 첫 번째 브랜치 푸시됨",
    "プロジェクトにちなんで名付けられた · オリジンワイヤード · 最初のブランチがプッシュされた",
    "تم تسميته على اسم المشروع · مصدر موصول · دفع الفرع الأول",
    "chiamato così dal progetto · origine collegata · primo ramo inviato"
  ],
  [
    "native",
    "本地",
    "원어민",
    "ネイティブ",
    "أصلي",
    "nativo"
  ],
  [
    "Native Rust supervises every subprocess with",
    "Native Rust 使用以下方式监督每个子进程",
    "Native Rust는 모든 하위 프로세스를 감독합니다",
    "Native Rustはすべてのサブプロセスを監督します",
    "Rust الأصلي يشرف على كل عملية فرعية مع",
    "Rust nativo supervisiona ogni sottoprocesso con"
  ],
  [
    "Navigate the already-open persistent browser to a new URL (same logged-in",
    "将已打开的持久浏览器导航到新 URL（同一登录状态",
    "이미 열린 지속 브라우저를 새 URL로 이동 (같은 로그인 상태)",
    "すでに開いている永続ブラウザを新しいURLにナビゲートする（同じログイン状態で）",
    "التنقل إلى عنوان URL جديد في المتصفح الدائم المفتوح بالفعل (نفس تسجيل الدخول",
    "Naviga il browser persistente già aperto verso un nuovo URL (stesso accesso)"
  ],
  [
    "Need a certificate? Open Apple portal",
    "需要证书？打开苹果门户",
    "인증서가 필요하신가요? Apple 포털을 여세요",
    "証明書が必要ですか？Appleポータルを開く",
    "هل تحتاج إلى شهادة؟ افتح بوابة آبل",
    "Hai bisogno di un certificato? Apri il portale Apple"
  ],
  [
    "Needed by the Apple CSR / .cer import flows. On Windows it ships with Git.",
    "Apple CSR / .cer 导入流程所需。在 Windows 上它随 Git 一起提供。",
    "Apple CSR / .cer 가져오기 과정에서 필요합니다. Windows에서는 Git과 함께 제공됩니다.",
    "Apple CSR / .cer インポートフローで必要です。WindowsではGitに同梱されています。",
    "مطلوبة لتدفقات استيراد Apple CSR / .cer. على نظام ويندوز تأتي مع Git.",
    "Necessario per i flussi di importazione CSR / .cer di Apple. Su Windows è fornito con Git."
  ],
  [
    "needs install",
    "需要安装",
    "설치 필요",
    "インストールが必要",
    "تحتاج للتثبيت",
    "necessita di installazione"
  ],
  [
    "Needs: {0}",
    "需要：{0}",
    "필요: {0}",
    "必要: {0}",
    "المطلوب: {0}",
    "Necessita: {0}"
  ],
  [
    "needsUser",
    "需要用户",
    "사용자 필요",
    "ユーザーが必要",
    "يحتاج مستخدم",
    "necessitaUtente"
  ],
  [
    "Network & reachability (WAN)",
    "网络与可达性（广域网）",
    "네트워크 및 연결성 (WAN)",
    "ネットワークと到達性（WAN）",
    "الشبكة وقابلية الوصول (الشبكة الواسعة)",
    "Rete e raggiungibilità (WAN)"
  ],
  [
    "Neural/semantic search by exa.ai. Returns full text per result. Free 1000 q/mo, no card.",
    "由 exa.ai 提供的神经/语义搜索。每个结果返回全文。每月免费 1000 次查询，无需信用卡。",
    "exa.ai의 신경망/의미 검색. 결과당 전체 텍스트 반환. 매월 1000회 무료, 카드 필요 없음.",
    "exa.aiによるニューラル／意味検索。結果ごとに全文を返します。月間1000問い合わせまで無料、カード不要。",
    "البحث العصبي/الدلالي بواسطة exa.ai. يعرض النص الكامل لكل نتيجة. مجاني 1000 سؤال/شهر، بدون بطاقة.",
    "Ricerca neurale/semantica di exa.ai. Restituisce il testo completo per risultato. Gratis 1000 domande/mese, senza carta."
  ],
  [
    "new",
    "新",
    "새",
    "新規",
    "جديد",
    "NUOVO"
  ],
  [
    "NEW",
    "新",
    "새로운",
    "新しい",
    "جديد",
    "NUOVO"
  ],
  [
    "New chat",
    "新聊天",
    "새 채팅",
    "新しいチャット",
    "دردشة جديدة",
    "Nuova chat"
  ],
  [
    "New chat (no project)",
    "新聊天（无项目）",
    "새 채팅 (프로젝트 없음)",
    "新しいチャット（プロジェクトなし）",
    "دردشة جديدة (بدون مشروع)",
    "Nuova chat (nessun progetto)"
  ],
  [
    "New conversation",
    "新对话",
    "새 대화",
    "新しい会話",
    "محادثة جديدة",
    "Nuova conversazione"
  ],
  [
    "New here?",
    "新来的吗？",
    "처음이신가요?",
    "初めてですか？",
    "جديد هنا؟",
    "Nuovo qui?"
  ],
  [
    "New page",
    "新页面",
    "새 페이지",
    "新しいページ",
    "صفحة جديدة",
    "Nuova pagina"
  ],
  [
    "New product",
    "新产品",
    "신제품",
    "新しい製品",
    "منتج جديد",
    "Nuovo prodotto"
  ],
  [
    "New project…",
    "新项目…",
    "새로운 프로젝트…",
    "新しいプロジェクト…",
    "مشروع جديد…",
    "Nuovo progetto…"
  ],
  [
    "New rule — Enter to add",
    "新规则 — 按回车键添加",
    "새 규칙 — 추가하려면 Enter를 누르세요",
    "新しいルール — 入力して追加",
    "قاعدة جديدة — اضغط إدخال للإضافة",
    "Nuova regola — Premi Invio per aggiungere"
  ],
  [
    "🆕 Start fresh",
    "🆕 全新开始",
    "🆕 새로 시작",
    "🆕 新しく始める",
    "🆕 ابدأ من جديد",
    "🆕 Inizia da capo"
  ],
  [
    "New team name",
    "新团队名称",
    "새 팀 이름",
    "新しいチーム名",
    "اسم الفريق الجديد",
    "Nuovo nome del team"
  ],
  [
    "new-branch-name",
    "新分支名称",
    "새-브랜치-이름",
    "新しいブランチ名",
    "اسم الفرع الجديد",
    "nuovo-nome-ramo"
  ],
  [
    "Newest first",
    "最新优先",
    "최신 항목 우선",
    "新しいものが最初",
    "الأحدث أولاً",
    "Più recenti per primi"
  ],
  [
    "next",
    "下一步",
    "다음",
    "次へ",
    "التالي",
    "Avanti"
  ],
  [
    "Next",
    "下一个",
    "다음",
    "次",
    "التالي",
    "Successivo"
  ],
  [
    "Next steps",
    "接下来的步骤",
    "다음 단계",
    "次のステップ",
    "الخطوات التالية",
    "Prossimi passi"
  ],
  [
    "next to the source. Each quant lands as its own card so you can keep several at once.",
    "靠近源头。每个量化都会生成自己的卡片，因此你可以同时保留多个。",
    "소스 옆. 각 퀀트는 자체 카드로 나타나서 여러 개를 한 번에 유지할 수 있습니다.",
    "ソースの隣。各量はそれぞれのカードとして配置されるので、複数を同時に保持できます。",
    "بالقرب من المصدر. كل وحدة كمية تهبط كبطاقة مستقلة حتى تتمكن من الاحتفاظ بعدة وحدات في وقت واحد.",
    "accanto alla fonte. Ogni quant arriva come la propria scheda così puoi tenerne diverse contemporaneamente."
  ],
  [
    "no",
    "否",
    "아니요",
    "いいえ",
    "لا",
    "No"
  ],
  [
    "No",
    "不",
    "아니요",
    "いいえ",
    "لا",
    "No"
  ],
  [
    "no `owllm/` or `.owllm` memory file). PROJECT DOCUMENTATION is different: it lives in",
    "没有 `owllm/` 或 `.owllm` 内存文件)。项目文档不同：它保存在",
    "`owllm/` 또는 `.owllm` 메모리 파일은 사용하지 않음). 프로젝트 문서는 다릅니다: 그것은 다음 위치에 있습니다",
    "`owllm/` または `.owllm` メモリファイルはなし)。プロジェクトドキュメントは異なります: それは ",
    "لا يوجد ملف ذاكرة `owllm/` أو `.owllm`). مستندات المشروع مختلفة: فهي موجودة في ",
    "nessun file di memoria `owllm/` o `.owllm`). LA DOCUMENTAZIONE DEL PROGETTO è diversa: si trova in"
  ],
  [
    "No account yet? The sign-in page lets you create one free in a minute — come back here and it connects automatically. (Or",
    "还没有账户？登录页面允许你在一分钟内免费创建一个账户 — 然后回来这里，它会自动连接。（或者",
    "아직 계정이 없으신가요? 로그인 페이지에서 1분 안에 무료로 계정을 만들 수 있습니다 — 여기로 다시 돌아오면 자동으로 연결됩니다. (또는",
    " にあります。\nまだアカウントがありませんか？サインインページから1分で無料で作成でき、ここに戻ると自動的に接続されます。（または ",
    "لا تملك حسابًا بعد؟ صفحة تسجيل الدخول تتيح لك إنشاء واحد مجانًا في دقيقة — عد إلى هنا وسوف يتصل تلقائيًا. (أو",
    "Non hai ancora un account? La pagina di accesso ti permette di crearne uno gratis in un minuto — torna qui e si connette automaticamente. (Oppure"
  ],
  [
    "No activity yet. Click Install or Connect on any provider to see the live output here instead of a pop-out console.",
    "尚无活动。点击任何提供商的安装或连接，以便在此查看实时输出，而不是弹出控制台。",
    "아직 활동이 없습니다. 설치 또는 제공업체 중 하나에 연결을 클릭하여 팝업 콘솔 대신 여기에서 실시간 출력을 확인하세요.",
    "まだアクティビティはありません。任意のプロバイダーでインストールまたは接続をクリックすると、ポップアウトコンソールの代わりにここでライブ出力を表示できます。",
    "لا توجد نشاطات بعد. انقر على تثبيت أو توصيل مع أي مزود لرؤية الإخراج المباشر هنا بدلاً من وحدة التحكم المنبثقة.",
    "Ancora nessuna attività. Clicca su Installa o Connetti su qualsiasi provider per vedere l'output in diretta qui invece di una console separata."
  ],
  [
    "no address yet — enable remote control on it",
    "尚未有地址 — 在其上启用远程控制",
    "아직 주소가 없음 — 원격 제어를 활성화하세요",
    " まだアドレスがありません — それでリモートコントロールを有効にしてください",
    "لا يوجد عنوان بعد — فعّل التحكم عن بعد عليه",
    "nessun indirizzo ancora — abilita il controllo remoto su di esso"
  ],
  [
    "No agents on this team yet. Pick a template via",
    "这个团队中还没有代理。通过选择模板",
    "이 팀에는 아직 에이전트가 없습니다. 템플릿을 선택하세요.",
    "  \nこのチームにはまだエージェントがいません。テンプレートを選んでください  ",
    "لا يوجد وكلاء في هذا الفريق بعد. اختر قالبًا عبر",
    "Nessun agente in questa squadra ancora. Scegli un modello tramite"
  ],
  [
    "No API key saved",
    "未保存 API 密钥",
    "저장된 API 키가 없음",
    "APIキーが保存されていません",
    "لم يتم حفظ مفتاح API",
    "Nessuna chiave API salvata"
  ],
  [
    "no app can change it",
    "没有应用可以更改它",
    "어떤 앱도 이것을 변경할 수 없습니다.",
    "  \nどのアプリもこれを変更できません  ",
    "لا يمكن لأي تطبيق تغييره",
    "nessuna app può cambiarlo"
  ],
  [
    "No assets yet",
    "还没有资产",
    "아직 자산이 없습니다.",
    "  \nまだ資産がありません  ",
    "لا توجد أصول بعد",
    "Nessun patrimonio ancora"
  ],
  [
    "No browsers with saved passwords found.",
    "未找到带有已保存密码的浏览器。",
    "저장된 비밀번호가 있는 브라우저를 찾을 수 없습니다.",
    "  \n保存されたパスワードのあるブラウザは見つかりませんでした  ",
    "لم يتم العثور على متصفحات بها كلمات مرور محفوظة.",
    "Nessun browser con password salvate trovato."
  ],
  [
    "No cloud accounts connected yet — connect one on the",
    "尚未连接任何云账户 — 请在上面连接一个",
    "아직 연결된 클라우드 계정이 없음 — 여기에서 하나를 연결하세요",
    "クラウドアカウントがまだ接続されていません — 1つ接続してください",
    "لم يتم توصيل أي حسابات سحابة بعد — قم بتوصيل واحد على",
    "Nessun account cloud ancora connesso — connettene uno su"
  ],
  [
    "No custom agents yet — Duplicate any built-in to make your own.",
    "尚无自定义代理 — 复制任何内置代理以创建自己的代理。",
    "아직 사용자 지정 에이전트가 없음 — 기본 제공 항목을 복제하여 나만의 에이전트를 만드세요.",
    "カスタムエージェントはまだありません — 組み込みのものを複製して自分のものを作成してください",
    "لا توجد وكلاء مخصصون بعد — قم بنسخ أي من المدمجين لإنشاء وكيلك الخاص.",
    "Nessun agente personalizzato ancora — Duplica qualsiasi agente integrato per creare il tuo."
  ],
  [
    "No description provided.",
    "未提供描述。",
    "설명이 제공되지 않았습니다.",
    "  \n説明は提供されていません  ",
    "لم يتم تقديم وصف.",
    "Nessuna descrizione fornita."
  ],
  [
    "No downloaded models match the current filter / search.",
    "没有已下载的模型符合当前过滤器/搜索。",
    "다운로드된 모델 중 현재 필터/검색과 일치하는 것이 없습니다.",
    "  \nダウンロードしたモデルは現在のフィルター/検索に一致しません  ",
    "لا تتطابق أي نماذج تم تنزيلها مع الفلتر / البحث الحالي.",
    "Nessun modello scaricato corrisponde al filtro/ricerca attuale."
  ],
  [
    "No durable facts to graph yet — toggle “Show worklog” to see recent agent activity.",
    "还没有可绘制的持久事实——切换“显示工作日志”以查看最近的代理活动。",
    "아직 그래프로 표시할 지속적인 사실이 없습니다 — 최근 에이전트 활동을 보려면 '작업 로그 표시'를 전환하세요.",
    "グラフに表示する耐久事実はまだありません — 最近のエージェント活動を見るには「作業ログを表示」を切り替えてください",
    "لا توجد حقائق دائمة للرسم بعد — قم بتبديل \"إظهار سجل العمل\" لرؤية النشاط الأخير للوكلاء.",
    "Nessun fatto duraturo da visualizzare ancora — attiva “Mostra registro lavori” per vedere l'attività recente degli agenti."
  ],
  [
    "No engine output yet.",
    "尚无引擎输出。",
    "아직 엔진 출력이 없습니다.",
    "  \nエンジン出力はまだありません",
    "لا يوجد إخراج من المحرك بعد.",
    "Nessuna uscita motore ancora."
  ],
  [
    "No entries in {0}.",
    "{0} 中没有条目。",
    "{0}에 항목이 없습니다.",
    "{0} にエントリーはありません。",
    "لا توجد إدخالات في {0}.",
    "Nessuna voce in {0}."
  ],
  [
    "No environments available.",
    "没有可用环境。",
    "사용 가능한 환경이 없습니다.",
    "利用可能な環境はありません。",
    "لا توجد بيئات متاحة.",
    "Nessun ambiente disponibile."
  ],
  [
    "No facts yet. Agents save durable knowledge here as they work — or add one below.",
    "还没有事实。代理在工作时会将持久知识保存在这里——或者在下面添加一个。",
    "아직 사실이 없습니다. 에이전트가 작업하면서 지속적인 지식을 여기에 저장하거나 아래에 하나를 추가합니다.",
    "まだ事実はありません。エージェントは作業中にここに持続可能な知識を保存するか、下に1つ追加します。",
    "لا توجد حقائق بعد. يقوم الوكلاء بحفظ المعرفة المستديمة هنا أثناء عملهم — أو أضف واحدة أدناه. ",
    "Ancora nessun fatto. Gli agenti salvano qui la conoscenza durevole mentre lavorano — oppure aggiungi uno qui sotto."
  ],
  [
    "No Feature Priority table in BRIEF.md yet — ask the co-founder to add one, or use the Conversation view.",
    "BRIEF.md 中还没有功能优先级表——请让联合创始人添加，或者使用会话视图。",
    "BRIEF.md에 아직 기능 우선순위 표가 없습니다 — 공동 창업자에게 추가하도록 요청하거나 대화 보기를 사용하세요.",
    "BRIEF.mdにはまだ機能優先度表がありません — 共同創設者に追加を依頼するか、会話ビューを使用してください。",
    "لا يوجد جدول أولوية الميزات في BRIEF.md بعد — اطلب من المؤسس المشارك إضافته، أو استخدم عرض المحادثة. ",
    "Ancora nessuna tabella Priorità Funzionalità in BRIEF.md — chiedi al co-fondatore di aggiungerne una, oppure usa la vista Conversazione."
  ],
  [
    "No file path was detected in the error",
    "在错误中未检测到文件路径",
    "오류에서 파일 경로가 감지되지 않았습니다.",
    "エラーでファイルパスは検出されませんでした。",
    "لم يتم اكتشاف مسار الملف في الخطأ.",
    "Nessun percorso di file rilevato nell'errore"
  ],
  [
    "no focus",
    "无焦点",
    "집중 없음",
    "フォーカスなし",
    "لا تركيز.",
    "niente focus"
  ],
  [
    "No GPU detected ·",
    "未检测到 GPU ·",
    "GPU가 감지되지 않았습니다 ·",
    "GPUが検出されません",
    "لم يتم الكشف عن GPU · ",
    "Nessuna GPU rilevata ·"
  ],
  [
    "No GPUs visible — nvidia-smi unreachable.",
    "未发现可见 GPU——nvidia-smi 无法访问。",
    "GPU가 보이지 않습니다 — nvidia-smi에 접근할 수 없습니다.",
    "GPUが見えません — nvidia-smiにアクセスできません。",
    "لا توجد وحدات معالجة رسومات مرئية — nvidia-smi غير متاحة. ",
    "Nessuna GPU visibile — nvidia-smi non raggiungibile."
  ],
  [
    "No in-app registry yet — there's no public MCP marketplace API the way HuggingFace has the model hub. The canonical lists live on GitHub. Pick a server from one of these, grab its",
    "尚无应用内注册——没有像 HuggingFace 的模型中心那样的公共 MCP 市场 API。规范列表托管在 GitHub 上。从这些列表中选择一个服务器，获取它的",
    "아직 앱 내 등록소 없음 — HuggingFace에 모델 허브가 있는 방식의 공개 MCP 마켓플레이스 API는 없습니다. 정식 목록은 GitHub에서 확인할 수 있습니다. 이 중 하나의 서버를 선택하고 가져오세요.",
    "アプリ内レジストリはまだありません — HuggingFaceのモデルハブのような公開MCPマーケットプレイスAPIはありません。正式なリストはGitHubにあります。これらのうちの1つのサーバーを選び、その",
    "لا يوجد سجل داخل التطبيق بعد — لا توجد واجهة برمجة تطبيقات سوق MCP عامة كما هو الحال مع مركز النماذج في HuggingFace. القوائم الرسمية موجودة على GitHub. اختر خادمًا من أحد هذه، واحصل على... ",
    "Ancora nessun registro in-app — non esiste un'API pubblica del marketplace MCP come HuggingFace ha l'hub dei modelli. Le liste canoniche sono su GitHub. Scegli un server da uno di questi, prendi il suo"
  ],
  [
    "No local model available — load one on the Models page.",
    "本地没有模型——请在模型页面加载一个。",
    "로컬 모델 없음 — 모델 페이지에서 하나를 불러오세요.",
    "ローカルモデルが利用できません — モデルページでロードしてください。",
    "لا يوجد نموذج محلي متاح — قم بتحميل واحد من صفحة النماذج.",
    "Nessun modello locale disponibile — caricane uno nella pagina Modelli."
  ],
  [
    "No loss data yet — start a run to see the curve.",
    "还没有损失数据——开始运行以查看曲线。",
    "손실 데이터 없음 — 실행을 시작해 곡선을 확인하세요.",
    "まだ損失データはありません — 曲線を見るには実行を開始してください。",
    "لا توجد بيانات خسارة بعد — ابدأ تشغيلًا لرؤية المنحنى.",
    "Ancora nessun dato di perdita — avvia una sessione per vedere la curva."
  ],
  [
    "No Mac? Generate the signing request (CSR) here",
    "没有 Mac？在这里生成签名请求（CSR）",
    "Mac이 없나요? 여기에서 서명 요청(CSR)을 생성하세요.",
    "Macをお持ちでないですか？ ここで署名要求（CSR）を生成してください",
    "لا جهاز Mac؟ أنشئ طلب التوقيع (CSR) هنا.",
    "Niente Mac? Genera la richiesta di firma (CSR) qui"
  ],
  [
    "No MCP servers configured. Add one below or click + Add Server.",
    "没有配置 MCP 服务器。在下面添加一个或点击 + 添加服务器。",
    "MCP 서버가 구성되지 않았습니다. 아래에 하나 추가하거나 + 서버 추가를 클릭하세요.",
    "MCPサーバーが構成されていません。以下に追加するか、+ サーバー追加をクリックしてください。",
    "لا توجد خوادم MCP مُهيأة. أضف واحدة أدناه أو انقر + إضافة خادم.",
    "Nessun server MCP configurato. Aggiungine uno qui sotto o clicca + Aggiungi Server."
  ],
  [
    "No memory to graph yet — agents (and you) add notes as the team works.",
    "还没有内存图——代理（以及你）在团队工作时添加笔记。",
    "그래프를 그릴 메모리 없음 — 에이전트(및 당신)가 팀 작업 중 노트를 추가합니다.",
    "まだグラフにするメモリはありません — チームが作業する中でエージェント（およびあなた）がノートを追加します。",
    "لا توجد ذاكرة للرسم البياني بعد — يضيف العملاء (وأنت) ملاحظات بينما يعمل الفريق.",
    "Ancora nessuna memoria da graficare — gli agenti (e tu) aggiungono note mentre il team lavora."
  ],
  [
    "no model",
    "没有模型",
    "모델 없음",
    "モデルなし",
    "لا يوجد نموذج.",
    "niente modello"
  ],
  [
    "No model for the second agent — pick one in the second-agent pane (or select a primary model).",
    "第二个代理没有模型——请在第二代理面板中选择一个（或选择主模型）。",
    "두 번째 에이전트용 모델 없음 — 두 번째 에이전트 창에서 하나를 선택하거나(또는 주 모델을 선택하세요).",
    "2番目のエージェントのモデルがありません — 2番目のエージェントのペインで1つ選択するか、主モデルを選択してください。",
    "لا يوجد نموذج للوكيل الثاني — اختر واحدًا في لوحة الوكيل الثاني (أو اختر نموذجًا أساسيًا).",
    "Nessun modello per il secondo agente — scegli uno nel pannello del secondo agente (o seleziona un modello principale)."
  ],
  [
    "No model picked. Set a team default model first.",
    "未选择模型。请先设置团队默认模型。",
    "모델이 선택되지 않았습니다. 먼저 팀 기본 모델을 설정하세요.",
    "モデルが選択されていません。まずチームのデフォルトモデルを設定してください。",
    "لم يتم اختيار نموذج. قم بتعيين نموذج افتراضي للفريق أولاً.",
    "Nessun modello selezionato. Imposta prima un modello predefinito per il team."
  ],
  [
    "No model selected — pick one above.",
    "未选择模型——请在上方选择一个。",
    "모델이 선택되지 않았습니다 — 위에서 하나를 선택하세요.",
    "モデルが選択されていません — 上で1つ選択してください。",
    "لم يتم اختيار نموذج — اختر واحدًا أعلاه.",
    "Nessun modello selezionato — scegline uno sopra."
  ],
  [
    "No models downloaded yet.",
    "还没有下载模型。",
    "아직 다운로드된 모델이 없습니다.",
    "まだモデルはダウンロードされていません。",
    "لم يتم تحميل أي نماذج بعد.",
    "Ancora nessun modello scaricato."
  ],
  [
    "No models matched \"",
    "没有匹配的模型",
    "일치하는 모델이 없습니다.",
    "一致するモデルはありません ",
    "لم يتم مطابقة أي نماذج",
    "Nessun modello corrispondente"
  ],
  [
    "No past chats yet.",
    "还没有聊天记录。",
    "아직 이전 채팅이 없습니다.",
    "まだ過去のチャットはありません。",
    "لا توجد محادثات سابقة بعد.",
    "Nessuna chat precedente."
  ],
  [
    "No past runs found in fine_tuned/.",
    "在 fine_tuned/ 中未找到过去的运行。",
    "fine_tuned/에서 이전 실행을 찾을 수 없습니다.",
    "fine_tuned/ に過去の実行は見つかりません。",
    "لم يتم العثور على أي تشغيلات سابقة في fine_tuned/.",
    "Nessuna esecuzione precedente trovata in fine_tuned/."
  ],
  [
    "no probe",
    "没有探测",
    "프러브가 없습니다.",
    "プローブはありません",
    "لا توجد مراقبة",
    "nessuna sonda"
  ],
  [
    "no project location set",
    "未设置项目位置",
    "프로젝트 위치가 설정되지 않았습니다.",
    "プロジェクトの場所が設定されていません",
    "لم يتم تعيين موقع المشروع",
    "nessuna posizione del progetto impostata"
  ],
  [
    "No project rules yet — type one above to add.",
    "尚无项目规则——请在上方输入以添加。",
    "아직 프로젝트 규칙이 없습니다 — 추가하려면 위에 입력하세요.",
    "まだプロジェクトのルールはありません — 上にタイプして追加してください。",
    "لا توجد قواعد للمشروع بعد — اكتب واحدة أعلاه لإضافتها.",
    "Ancora nessuna regola di progetto — digitarne una sopra per aggiungerla."
  ],
  [
    "No project selected",
    "未选择项目",
    "선택된 프로젝트가 없습니다.",
    "選択されたプロジェクトはありません",
    "لم يتم تحديد أي مشروع",
    "Nessun progetto selezionato"
  ],
  [
    "No projects yet — create one on the left to get started.",
    "尚无项目——在左侧创建一个以开始。",
    "아직 프로젝트가 없습니다 — 시작하려면 왼쪽에서 하나를 만드세요.",
    "まだプロジェクトはありません — 左側で作成して開始してください。",
    "لا توجد مشاريع بعد — أنشئ واحدًا على اليسار للبدء.",
    "Ancora nessun progetto — creane uno a sinistra per iniziare."
  ],
  [
    "No quantization variants found — this repo ships a single weight set, just hit \"Download all\".",
    "未找到量化变体——此仓库只提供单一权重集，直接点击“全部下载”即可。",
    "양자화 변형이 발견되지 않았습니다 — 이 저장소는 단일 가중치 세트를 제공합니다, 그냥 \"모두 다운로드\"를 누르세요.",
    "量子化バリアントが見つかりません — このリポジトリは単一の重みセットを提供しているだけなので、「すべてダウンロード」をクリックしてください。",
    "لم يتم العثور على أي نسخ كمية — هذا المستودع يحتوي على مجموعة وزن واحدة فقط، فقط اضغط على \"تحميل الكل\".",
    "Nessuna variante di quantizzazione trovata — questo repository offre un unico set di pesi, basta cliccare su \"Scarica tutto\"."
  ],
  [
    "No reasoning yet — the model's thinking blocks land here while the team runs.",
    "尚未推理——模型的思考模块在这里暂停，同时团队运行中。",
    "아직 추론 없음 — 팀이 실행하는 동안 모델의 사고 블록이 여기로 옵니다.",
    "まだ推論はありません — チームが実行している間、モデルの思考ブロックはここに表示されます。",
    "لا يوجد تفكير بعد — كتل تفكير النموذج تصل إلى هنا بينما يعمل الفريق.",
    "Ancora nessun ragionamento — qui arrivano i blocchi di pensiero del modello mentre il team lavora."
  ],
  [
    "no reboot is needed",
    "不需要重启",
    "재부팅이 필요하지 않습니다.",
    "再起動は必要ありません",
    "لا حاجة لإعادة التشغيل",
    "non è necessario riavviare"
  ],
  [
    "No recommended models match these filters. Clear them or run a search.",
    "没有推荐模型符合这些过滤条件。清除它们或进行搜索。",
    "이 필터와 일치하는 추천 모델이 없습니다. 필터를 지우거나 검색을 실행하세요.",
    "これらのフィルタに一致する推奨モデルはありません。フィルタをクリアするか、検索を実行してください。",
    "لا توجد نماذج موصى بها تتطابق مع هذه الفلاتر. امسحها أو قم بإجراء بحث.",
    "Nessun modello consigliato corrisponde a questi filtri. Cancellali o esegui una ricerca."
  ],
  [
    "No rules yet — add one above. Examples: \"keep modules under 500 lines\", \"never use mocks in tests\", \"ship as production-ready, not prototype\".",
    "尚无规则——请在上方添加一条。例如：“保持模块少于500行”、“测试中绝不使用模拟”、“发布为生产就绪，而非原型”。",
    "아직 규칙 없음 — 위에 하나 추가하세요. 예시: \"모듈은 500라인 이하로 유지\", \"테스트에 모킹 사용 금지\", \"프로토타입이 아니라 프로덕션 준비 상태로 배포\".",
    "まだルールはありません — 上に追加してください。例: 「モジュールは500行未満にする」「テストでモックを使用しない」「試作ではなく本番準備済みとして出荷する」。",
    "لا توجد قواعد بعد — أضف واحدة أعلاه. أمثلة: \"حافظ على الوحدات تحت 500 سطر\"، \"لا تستخدم النسخ الوهمية في الاختبارات أبدًا\"، \"اشحنها جاهزة للإنتاج، ليست نموذجًا أوليًا\".",
    "Ancora nessuna regola — aggiungine una sopra. Esempi: \"mantieni i moduli sotto le 500 righe\", \"non usare mai mock nei test\", \"spedisci come pronto per la produzione, non come prototipo\"."
  ],
  [
    "No saved passwords yet. Add one below or Import from a browser.",
    "还没有保存的密码。在下方添加一个或从浏览器导入。",
    "저장된 비밀번호가 아직 없습니다. 아래에 추가하거나 브라우저에서 가져오세요.",
    "まだ保存されたパスワードはありません。下に追加するか、ブラウザからインポートしてください。",
    "لا توجد كلمات مرور محفوظة بعد. أضف واحدة أدناه أو استوردها من متصفح.",
    "Ancora nessuna password salvata. Aggiungine una sotto oppure importa da un browser."
  ],
  [
    "No saved team template backs this roster",
    "没有保存的团队模板支持此花名册。",
    "저장된 팀 템플릿이 이 명단을 지원하지 않습니다.",
    "このチームのテンプレートは保存されていません",
    "لا يدعم أي قالب فريق محفوظ هذا الجدول.",
    "Nessun modello di team salvato supporta questo elenco."
  ],
  [
    "No signing certificate is configured (⚙ Set up repo → Code signing), so this build will be UNSIGNED.",
    "未配置签名证书（⚙ 设置仓库 → 代码签名），因此此次构建将为未签名。",
    "서명 인증서가 구성되지 않았습니다 (⚙ 저장소 설정 → 코드 서명), 따라서 이 빌드는 서명되지 않습니다.",
    "署名証明書が設定されていません（⚙ リポジトリの設定 → コード署名）、そのためこのビルドは未署名になります。",
    "لم يتم تكوين شهادة توقيع (⚙ إعداد المستودع → توقيع الكود)، لذا ستكون هذه النسخة غير موقعة.",
    "Nessun certificato di firma è configurato (⚙ Configura repo → Firma del codice), quindi questa build sarà NON FIRMATA."
  ],
  [
    "No signing certificate is configured, so this build will be UNSIGNED.",
    "未配置签名证书，因此此构建将为未签名。",
    "서명 인증서가 구성되어 있지 않으므로 이 빌드는 서명되지 않습니다.",
    "署名証明書が設定されていないため、このビルドは署名されません。",
    "لم يتم تكوين شهادة توقيع، لذا سيكون هذا البناء غير موقع.",
    "Nessun certificato di firma è configurato, quindi questa build sarà NON FIRMATA."
  ],
  [
    "No SKILL.md files found in this source.",
    "在此源代码中未找到 SKILL.md 文件。",
    "이 소스에서 SKILL.md 파일을 찾을 수 없습니다.",
    "このソースにはSKILL.mdファイルが見つかりません。",
    "لم يتم العثور على ملفات SKILL.md في هذا المصدر.",
    "Nessun file SKILL.md trovato in questa sorgente."
  ],
  [
    "No skills installed yet — add them in the 📚 Skills tab, then tick them here.",
    "尚未安装技能 — 在 📚 技能 标签中添加它们，然后在此勾选。",
    "아직 설치된 스킬이 없습니다 — 📚 스킬 탭에서 추가한 후, 여기에서 선택하세요.",
    "まだスキルはインストールされていません — 📚 スキルタブで追加し、ここでチェックしてください。",
    "لم يتم تثبيت أي مهارات بعد — أضفها في علامة تبويب 📚 المهارات، ثم ضع علامة عليها هنا.",
    "Ancora nessuna competenza installata — aggiungile nella scheda 📚 Competenze, poi selezionale qui."
  ],
  [
    "No skills installed yet.",
    "尚未安装技能。",
    "아직 스킬이 설치되지 않았습니다.",
    "まだスキルがインストールされていません。",
    "لا توجد مهارات مثبتة بعد.",
    "Nessuna competenza installata ancora."
  ],
  [
    "No skills installed yet. Click",
    "尚未安装技能。点击",
    "아직 스킬이 설치되지 않았습니다. 클릭하세요",
    "まだスキルがインストールされていません。クリック",
    "لا توجد مهارات مثبتة بعد. انقر",
    "Nessuna competenza installata ancora. Clicca"
  ],
  [
    "No skills match “",
    "没有技能匹配“",
    "“에 일치하는 스킬이 없습니다",
    "「一致するスキルがありません」",
    "لا توجد مهارات مطابقة",
    "Nessuna competenza corrisponde “"
  ],
  [
    "No skills match the current filter.",
    "没有与当前筛选条件匹配的技能。",
    "현재 필터와 일치하는 스킬이 없습니다.",
    "現在のフィルターに一致するスキルはありません。",
    "لا تطابق أي مهارات الفلتر الحالي.",
    "Nessuna competenza corrisponde al filtro corrente."
  ],
  [
    "No specialists on this team yet — open project settings (the",
    "此团队尚无专家 — 打开项目设置（",
    "아직 이 팀에 전문가가 없습니다 — 프로젝트 설정을 열어보세요 (",
    "このチームにはまだ専門家がいません — プロジェクト設定を開いてください",
    "لا يوجد متخصصون في هذا الفريق بعد — افتح إعدادات المشروع",
    "Nessuno specialista in questo team ancora — apri le impostazioni del progetto"
  ],
  [
    "No steps yet — add one above, or 🪄 digest your notes below.",
    "尚无步骤 — 在上方添加一个，或在下方 🪄 消化您的笔记。",
    "아직 단계가 없습니다 — 위에서 추가하거나, 아래에서 메모를 🪄 요약하세요.",
    "まだステップはありません — 上に追加するか、下のメモを🪄処理してください。",
    "لا توجد خطوات بعد — أضف واحدة أعلاه، أو 🪄 عالج ملاحظاتك أدناه.",
    "Nessun passaggio ancora — aggiungine uno sopra, o 🪄 elabora le tue note qui sotto."
  ],
  [
    "No team picked yet. Start a project from the Studio to populate the per-agent chat grid.",
    "尚未选择团队。从工作室启动项目以填充每个代理的聊天网格。",
    "아직 팀이 선택되지 않았습니다. Studio에서 프로젝트를 시작하여 에이전트별 채팅 격자를 채우세요.",
    "まだチームが選択されていません。スタジオからプロジェクトを開始して、エージェントごとのチャットグリッドを埋めてください。",
    "لم يتم اختيار فريق بعد. ابدأ مشروعًا من الاستوديو لملء شبكة الدردشة الخاصة بكل وكيل.",
    "Nessun team selezionato ancora. Avvia un progetto dallo Studio per popolare la griglia chat per agente."
  ],
  [
    "no team ready — pick a project & model",
    "没有准备好的团队 — 选择一个项目和模型",
    "준비된 팀이 없습니다 — 프로젝트와 모델을 선택하세요",
    "チームが準備できていません — プロジェクトとモデルを選択してください",
    "لا يوجد فريق جاهز — اختر مشروعًا ونموذجًا",
    "nessun team pronto — scegli un progetto e un modello"
  ],
  [
    "No text could be extracted — check the sources (PDFs need readable text; some need 'pypdf').",
    "无法提取文本——请检查来源（PDF 需要可读取的文本；有些需要 'pypdf'）。",
    "텍스트를 추출할 수 없습니다 — 소스를 확인하세요(PDF는 읽을 수 있는 텍스트가 필요하며, 일부는 'pypdf'가 필요합니다).",
    "テキストを抽出できませんでした — ソースを確認してください（PDFは読み取り可能なテキストが必要です; 一部には 'pypdf' が必要です）。",
    "لم يتم استخراج أي نص — تحقق من المصادر (ملفات PDF تحتاج إلى نص قابل للقراءة؛ بعض الملفات تحتاج إلى 'pypdf').",
    "Nessun testo è stato estratto — controlla le fonti (i PDF devono contenere testo leggibile; alcuni richiedono 'pypdf')."
  ],
  [
    "No tool calls yet — every command the agent runs (Bash, Read, Write, Edit, etc.) appears here with its arguments and the result it returned.",
    "尚未调用任何工具——代理运行的每个命令（Bash、读取、写入、编辑等）都会在此显示，包括其参数和返回结果。",
    "아직 도구 호출이 없습니다 — 에이전트가 실행하는 모든 명령(Bash, 읽기, 쓰기, 편집 등)이 여기에 인수와 반환된 결과와 함께 표시됩니다.",
    "まだツール呼び出しはありません — エージェントが実行するすべてのコマンド（Bash、読み取り、書き込み、編集など）はここに引数と返された結果とともに表示されます。",
    "لا توجد مكالمات أدوات بعد — كل أمر ينفذه الوكيل (Bash، قراءة، كتابة، تحرير، إلخ) يظهر هنا مع الوسائط والنتيجة التي أعادها.",
    "Nessuna chiamata agli strumenti ancora — ogni comando eseguito dall'agente (Bash, Leggi, Scrivi, Modifica, ecc.) appare qui con i suoi argomenti e il risultato che ha restituito."
  ],
  [
    "no traffic recorded yet for this account",
    "该账户尚未记录任何流量",
    "이 계정에 대해 기록된 트래픽 없음",
    "このアカウントではまだトラフィックが記録されていません",
    "لم يسجل أي حركة مرور حتى الآن لهذا الحساب",
    "nessun traffico registrato ancora per questo account"
  ],
  [
    "No TTS voices installed on this system",
    "系统上未安装任何 TTS 语音",
    "이 시스템에 설치된 TTS 음성 없음",
    "このシステムにはTTS音声がインストールされていません",
    "لا توجد أصوات تحويل النص إلى كلام مثبتة على هذا النظام",
    "Nessuna voce TTS installata su questo sistema"
  ],
  [
    "No tuned adapters yet.",
    "尚无调优适配器。",
    "아직 조정된 어댑터 없음",
    "チューニングされたアダプターはまだありません",
    "لا توجد موائمات مضبوطة حتى الآن.",
    "Nessun adattatore sintonizzato ancora."
  ],
  [
    "no username",
    "无用户名",
    "사용자 이름 없음",
    "ユーザー名なし",
    "لا يوجد اسم مستخدم",
    "nessun nome utente"
  ],
  [
    "No weight files found in this folder.",
    "在此文件夹中未找到权重文件。",
    "이 폴더에서 무게 파일을 찾을 수 없음",
    "このフォルダに重みファイルが見つかりません",
    "لم يتم العثور على ملفات الوزن في هذا المجلد.",
    "Nessun file di pesi trovato in questa cartella."
  ],
  [
    "No worklog yet. Recent agent turns are auto-recorded here during a run.",
    "尚无工作日志。运行期间最近的代理轮次会自动记录在此。",
    "아직 작업 로그 없음. 최근 에이전트 실행 기록은 실행 중에 자동으로 여기에 기록됩니다.",
    "作業ログはまだありません。最近のエージェントの操作は実行中に自動でここに記録されます",
    "لا يوجد سجل عمل بعد. يتم تسجيل الأدوار الأخيرة للوكيل تلقائيًا هنا أثناء التشغيل.",
    "Nessun registro di lavoro ancora. Le azioni recenti dell'agente vengono registrate automaticamente qui durante un'esecuzione."
  ],
  [
    "noise is filtered out. Use this to find symbols, callers,",
    "噪声已被过滤。使用此功能查找符号、调用者，",
    "노이즈가 제거됨. 이를 사용하여 심볼, 호출자를 찾으세요,",
    "ノイズはフィルタリングされています。シンボルや呼び出し元を見つけるためにこれを使用してください",
    "يتم فلترة الضوضاء. استخدم هذا للعثور على الرموز، المتصلين،",
    "il rumore viene filtrato. Usalo per trovare simboli, chiamanti,"
  ],
  [
    "None",
    "无",
    "없음",
    "なし",
    "لا شيء",
    "nessuna"
  ],
  [
    "none — equip from the catalog ◂",
    "无 — 从目录中装备 ◂",
    "없음 — 카탈로그에서 장비 선택 ◂",
    "なし — カタログから装備 ◂",
    "لا شيء — تجهيز من الكتالوج ◂",
    "nessuno — equipaggia dal catalogo ◂"
  ],
  [
    "none saved yet",
    "尚未保存",
    "아직 저장된 것 없음",
    "まだ保存されていません",
    "لا شيء محفوظ بعد",
    "nessuno salvato ancora"
  ],
  [
    "none yet",
    "尚无",
    "아직 없음",
    "まだなし",
    "لا يوجد بعد",
    "nessuno ancora"
  ],
  [
    "Normalizer report",
    "归一化器报告",
    "정규화 보고서",
    "正規化レポート",
    "تقرير المعالج",
    "Rapporto normalizzatore"
  ],
  [
    "Not connected.",
    "未连接。",
    "연결되지 않음.",
    "接続されていません。",
    "غير متصل.",
    "Non connesso."
  ],
  [
    "Not in the certificate store right now — plug the token, or start SimplySign for a Certum cloud cert.",
    "当前不在证书存储中 — 插入令牌，或为 Certum 云证书启动 SimplySign。",
    "현재 인증서 저장소에 없음 — 토큰을 연결하거나 Certum 클라우드 인증서를 위해 SimplySign을 시작하세요.",
    "現在、証明書ストアにありません — トークンを接続するか、Certumクラウド証明書用にSimplySignを起動してください。",
    "ليس في متجر الشهادات الآن — قم بتوصيل الرمز المميز، أو ابدأ SimplySign لشهادة سحابة Certum.",
    "Non presente nel negozio di certificati in questo momento — collega il token o avvia SimplySign per un certificato Certum cloud."
  ],
  [
    "not installed",
    "未安装",
    "설치되지 않음",
    "インストールされていません",
    "غير مثبت",
    "non installato"
  ],
  [
    "Not isolated: tools run on the host (write-jail + dangerous-command guard still apply).",
    "未隔离：工具在主机上运行（仍适用写入监狱 + 危险命令保护）。",
    "격리되지 않음: 도구가 호스트에서 실행됨(쓰기-감옥 + 위험 명령 보호는 여전히 적용됨).",
    "分離されていません: ツールはホスト上で実行されます（write-jail + 危険なコマンドガードは引き続き適用されます）。",
    "غير معزول: الأدوات تعمل على المضيف (ما زال تطبيق حظر الأوامر الخطرة + زنزانة الكتابة).",
    "Non isolato: gli strumenti vengono eseguiti sull'host (la scrittura-jail + la protezione da comandi pericolosi sono ancora applicate)."
  ],
  [
    "NOT READY ({0})",
    "未准备好 ({0})",
    "준비되지 않음 ({0})",
    "準備できていません ({0})",
    "غير جاهز ({0})",
    "NON PRONTO ({0})"
  ],
  [
    "not running",
    "未运行",
    "실행 중이 아님",
    "実行されていません",
    "لا يعمل",
    "non in esecuzione"
  ],
  [
    "Not signed in to GitHub — discovery has nothing to search.",
    "未登录 GitHub — 发现没有东西可搜索。",
    "GitHub에 로그인하지 않음 — 검색할 내용이 없음.",
    "GitHubにサインインしていません — 検出するものがありません。",
    "لم تقم بتسجيل الدخول إلى GitHub — لا شيء للبحث عنه.",
    "Non connesso a GitHub — la scoperta non ha nulla da cercare."
  ],
  [
    "not stored",
    "未存储",
    "저장되지 않음",
    "保存されていません",
    "غير مخزن",
    "Non memorizzato"
  ],
  [
    "Not stored",
    "未存储",
    "저장되지 않음",
    "保存されていません",
    "غير مخزن",
    "Non memorizzato"
  ],
  [
    "not supported",
    "不支持",
    "지원되지 않음",
    "サポートされていません",
    "غير مدعوم",
    "non supportato"
  ],
  [
    "Not sure which to install?",
    "不确定安装哪一个？",
    "무엇을 설치할지 확실하지 않음?",
    "どれをインストールするか分かりませんか？",
    "غير متأكد أي واحد لتثبيته؟",
    "Non sicuro su quale installare?"
  ],
  [
    "note (optional)",
    "备注（可选）",
    "참고 (선택 사항)",
    "メモ（オプション）",
    "ملاحظة (اختياري)",
    "nota (opzionale)"
  ],
  [
    "Note: requires a transformers-format model directory (not GGUF). If you only have GGUF, download the original HF weights first via the Models page.",
    "注意：需要一个 transformers 格式的模型目录（不是 GGUF）。如果你只有 GGUF，请先通过 Models 页面下载原始 HF 权重。",
    "참고: transformers 형식의 모델 디렉토리가 필요합니다 (GGUF 아님). GGUF만 있는 경우, 먼저 모델 페이지에서 원래 HF 가중치를 다운로드하세요.",
    "注意: transformers形式のモデルディレクトリが必要です（GGUFではありません）。GGUFしか持っていない場合は、まずModelsページから元のHFウェイトをダウンロードしてください。",
    "ملاحظة: يتطلب دليل نموذج بتنسيق transformers (ليس GGUF). إذا كان لديك فقط GGUF، قم أولاً بتنزيل الأوزان الأصلية من HF عبر صفحة النماذج.",
    "Nota: richiede una directory di modello in formato transformers (non GGUF). Se hai solo GGUF, scarica prima i pesi HF originali tramite la pagina dei Modelli."
  ],
  [
    "NOTE: team memory is a database, not a file — do NOT look for it on disk (there is",
    "注意：团队记忆是一个数据库，而不是一个文件——不要在磁盘上寻找它（有",
    "참고: 팀 메모리는 파일이 아니라 데이터베이스입니다 — 디스크에서 찾지 마세요 (다음 위치에 있습니다.",
    "注意：チームメモリはデータベースであり、ファイルではありません — ディスク上で探さないでください（存在しません）",
    "ملاحظة: ذاكرة الفريق هي قاعدة بيانات، وليست ملفًا — لا تبحث عنها على القرص (هناك",
    "NOTA: la memoria del team è un database, non un file — NON cercarla sul disco (c'è"
  ],
  [
    "Notebook",
    "笔记本",
    "노트북",
    "ノート",
    "دفتر",
    "Quaderno"
  ],
  [
    "Notebook — write working notes while agents run, digest them into a Kanban plan board and larger feedable steps, then feed steps to the team or auto-feed them run after run.",
    "笔记本——在代理运行时写工作笔记，将其整理成看板计划板和可喂给更大步骤的计划，然后将步骤提供给团队或自动在每次运行后喂给他们。",
    "노트북 — 에이전트가 실행되는 동안 작업 노트를 작성하고, 이를 칸반 계획 보드와 더 큰 실행 가능한 단계로 소화한 후, 단계별로 팀에 제공하거나 실행마다 자동으로 제공합니다.",
    "ノートブック — エージェントが実行される間に作業メモを書き、これをカンバン計画ボードやより大きなステップに整理し、そのステップをチームに渡すか、実行ごとに自動で渡します。",
    "دفتر ملاحظات — اكتب ملاحظات العمل أثناء تشغيل الوكلاء، وحولها إلى خطة لوحة كانبان وخطوات أكبر قابلة للتغذية، ثم قدم الخطوات للفريق أو قم بتغذيتها تلقائيًا مرة بعد مرة.",
    "Notebook — scrivi appunti di lavoro mentre gli agenti operano, trasformali in un piano Kanban e in passi più grandi da alimentare, poi fornisci i passi al team o alimentali automaticamente esecuzione dopo esecuzione."
  ],
  [
    "Nothing sent yet. Type below in the input dock and press Enter — every message you send to the team will land here as a log.",
    "尚未发送任何内容。在输入区域中键入，然后按回车——你发送给团队的每条信息都会作为日志记录在这里。",
    "아직 아무 것도 전송되지 않았습니다. 아래 입력 도크에 입력하고 Enter를 누르세요 — 팀에 보내는 모든 메시지는 여기 로그로 기록됩니다.",
    "まだ送信されていません。下の入力欄に入力してEnterキーを押してください — チームに送信するすべてのメッセージはここにログとして記録されます。",
    "لم يُرسل شيء بعد. اكتب أدناه في حوض الإدخال واضغط Enter — كل رسالة ترسلها إلى الفريق ستصل هنا كسجل.",
    "Niente inviato ancora. Digita qui sotto nel dock di input e premi Invio — ogni messaggio che invii al team finirà qui come registro."
  ],
  [
    "Nothing to save yet — generate pairs first.",
    "尚无可保存内容 — 请先生成配对。",
    "아직 저장할 것이 없습니다 — 먼저 쌍을 생성하세요.",
    "まだ保存するものはありません — まずペアを生成してください。",
    "لا يوجد شيء لحفظه بعد — أنشئ الأزواج أولاً.",
    "Niente da salvare ancora — genera prima le coppie."
  ],
  [
    "Nothing to sync — no CLI is logged in and no API keys are saved on this PC's Windows side (Accounts → Connect).",
    "没有可同步内容 — 没有 CLI 登录，也没有在此 PC 的 Windows 端保存任何 API 密钥（账户 → 连接）。",
    "동기화할 것이 없습니다 — CLI에 로그인되어 있지 않고, 이 PC의 Windows 측(계정 → 연결)에 API 키가 저장되어 있지 않습니다.",
    "同期するものはありません — CLIにはログインされておらず、このPCのWindows側（アカウント → 接続）にはAPIキーが保存されていません。",
    "لا يوجد شيء للمزامنة — لم يتم تسجيل الدخول إلى أي واجهة سطر أوامر ولا توجد مفاتيح API محفوظة على جانب Windows في هذا الكمبيوتر (الحسابات → اتصال).",
    "Niente da sincronizzare — nessun CLI è connesso e nessuna chiave API è salvata sul lato Windows di questo PC (Account → Connessione)."
  ],
  [
    "now",
    "现在",
    "지금",
    "今",
    "الآن",
    "Adesso"
  ],
  [
    "Now",
    "现在",
    "지금",
    "今",
    "الآن",
    "Adesso"
  ],
  [
    "npx",
    "npx",
    "npx",
    "npx",
    "npx",
    "npx"
  ],
  [
    "number",
    "数字",
    "숫자",
    "番号",
    "الرقم",
    "numero"
  ],
  [
    "Number of chats:",
    "聊天数量：",
    "채팅 수:",
    "チャットの数:",
    "عدد المحادثات:",
    "Numero di chat:"
  ],
  [
    "o_proj",
    "o_proj",
    "o_proj",
    "o_proj",
    "o_proj",
    "o_proj"
  ],
  [
    "of",
    "的",
    "의",
    "の",
    "of",
    "di"
  ],
  [
    "OFF",
    "关闭",
    "OFF",
    "オフ",
    "إيقاف",
    "SPENTO"
  ],
  [
    "OFF (default) — the model server is loopback-only; nothing on the network can reach it.",
    "关闭（默认） — 模型服务器仅限回环；网络上的任何东西都无法访问它。",
    "OFF(기본값) — 모델 서버는 루프백 전용입니다; 네트워크의 어떤 것도 서버에 접근할 수 없습니다.",
    "OFF（デフォルト） — モデルサーバーはループバックのみです；ネットワーク上の何もそれに到達できません。",
    "إيقاف التشغيل (افتراضي) — خادم النموذج يعمل على واجهة الاسترجاع فقط؛ لا يمكن لأي شيء على الشبكة الوصول إليه.",
    "OFF (predefinito) — il server del modello è solo in loopback; nulla sulla rete può raggiungerlo."
  ],
  [
    "Off = bind to 127.0.0.1 (localhost only). On = bind to 0.0.0.0 (any device on your local network can reach it). Set a Token if you flip this on.",
    "关闭 = 绑定到 127.0.0.1（仅本地主机）。开启 = 绑定到 0.0.0.0（本地网络上的任何设备都可以访问）。如果开启，请设置令牌。",
    "Off = 127.0.0.1에 바인딩(로컬호스트 전용). On = 0.0.0.0에 바인딩(로컬 네트워크의 어떤 장치도 접근 가능). 켜면 토큰을 설정하세요.",
    "オフ = 127.0.0.1 にバインド（ローカルホストのみ）。オン = 0.0.0.0 にバインド（ローカルネットワーク上のどのデバイスからもアクセス可能）。これをオンにする場合はトークンを設定してください。",
    "إيقاف = الربط على 127.0.0.1 (المضيف المحلي فقط). تشغيل = الربط على 0.0.0.0 (يمكن لأي جهاز على شبكتك المحلية الوصول إليه). قم بتعيين رمز إذا فعلت هذا.",
    "Spento = vincolato a 127.0.0.1 (solo localhost). Acceso = vincolato a 0.0.0.0 (qualsiasi dispositivo sulla rete locale può raggiungerlo). Imposta un Token se lo attivi."
  ],
  [
    "off: advisory only — never blocks the team",
    "关闭：仅供参考——永远不会阻止团队",
    "끄기: 안내용일 뿐 — 팀을 차단하지 않음  ",
    "off: 助言のみ — チームをブロックすることはありません",
    "إيقاف التشغيل: للاستشارة فقط — لا يمنع الفريق أبدًا",
    "off: solo informativo — non blocca mai il team"
  ],
  [
    "off: one task at a time (sequential)",
    "关闭：一次一个任务（顺序）",
    "off: 한 번에 한 작업(순차적)",
    "オフ: 一度に1つのタスク（順次）",
    "إيقاف: مهمة واحدة في كل مرة (متتابعة)",
    "spento: un compito alla volta (sequenziale)"
  ],
  [
    "Official MCP servers",
    "官方 MCP 服务器",
    "공식 MCP 서버",
    "公式 MCP サーバー",
    "الخوادم الرسمية MCP",
    "Server MCP ufficiali"
  ],
  [
    "ok",
    "好",
    "ok",
    "OK",
    "حسنًا",
    "ok"
  ],
  [
    "old_string must match the file byte-for-byte (whitespace included).",
    "old_string 必须与文件逐字节匹配（包括空格）。",
    "old_string은 파일 바이트 단위로 정확히 일치해야 합니다(공백 포함).",
    "old_string はファイルとバイト単位で一致する必要があります（空白を含む）。",
    "يجب أن يطابق old_string الملف بايت بايت (بما في ذلك الفراغات).",
    "old_string deve corrispondere al file byte per byte (spazi inclusi)."
  ],
  [
    "Oldest first",
    "最旧的优先",
    "가장 오래된 순",
    "古い順",
    "الأقدم أولاً",
    "Più vecchio prima"
  ],
  [
    "on",
    "开启",
    "on",
    "オン",
    "تشغيل",
    "acceso"
  ],
  [
    "on — for tech support, installing software, and development on the other machine. Admin/elevation on the target still needs its approval. Off by default.",
    "开启——用于技术支持、安装软件以及在另一台机器上进行开发。目标计算机上的管理员/权限提升仍需要其批准。默认关闭。",
    "켜기 — 다른 기기에서 기술 지원, 소프트웨어 설치, 개발용. 대상에서의 관리자/권한 상승은 여전히 승인이 필요함. 기본값은 끄기.  ",
    "オン — 技術サポート、ソフトウェアのインストール、および他のマシンでの開発用。ターゲットでの管理者権限/昇格には依然として承認が必要。デフォルトではオフ。",
    "تشغيل — للدعم الفني، وتثبيت البرامج، والتطوير على الجهاز الآخر. يحتاج المسؤول/الرفع على الهدف إلى موافقته. مُعطل بشكل افتراضي.",
    "acceso — per supporto tecnico, installazione software e sviluppo sull'altro computer. L'amministrazione/elevazione sul dispositivo di destinazione richiede ancora la sua approvazione. Disattivato di default."
  ],
  [
    "ON — other machines that can reach this PC on the model port can use it, with the key below. Binds 0.0.0.0.",
    "开启——其他能够通过模型端口访问此电脑的机器可以使用它，使用下面的密钥。绑定到0.0.0.0。",
    "켜기 — 모델 포트에서 이 PC에 접근할 수 있는 다른 기기들이 아래 키를 사용해 이용 가능. 0.0.0.0에 바인딩됨.  ",
    "オン — モデルポートでこのPCにアクセスできる他のマシンは、下記のキーを使って利用可能。0.0.0.0 にバインドされる。",
    "تشغيل — الأجهزة الأخرى التي يمكنها الوصول إلى هذا الكمبيوتر عبر منفذ النموذج يمكنها استخدامه، بالمفتاح أدناه. يربط 0.0.0.0.",
    "ACCESO — altri computer che possono raggiungere questo PC sulla porta modello possono usarlo, con la chiave qui sotto. Si lega a 0.0.0.0."
  ],
  [
    "on · ~",
    "开启 · ~",
    "켜기 · ~  ",
    "オン · ~",
    "تشغيل · ~",
    "acceso · ~"
  ],
  [
    "on its own branch…",
    "在它自己的分支上…",
    "자체 브랜치에서 켜기…",
    "独自のブランチでオン…",
    "على فرعه الخاص…",
    "sul suo ramo..."
  ],
  [
    "On most PCs this is already on — yours just happens to have it off.",
    "在大多数电脑上，这个功能已经开启——只是你的电脑恰好是关闭的。",
    "대부분의 PC에서는 이것이 이미 켜져 있습니다 — 당신의 PC만 우연히 꺼져 있는 것입니다.",
    "ほとんどのPCではこれはすでにオン — あなたのPCはたまたまオフになっているだけ。",
    "على معظم أجهزة الكمبيوتر يكون هذا مُفعلًا بالفعل — جهازك فقط حالته مُعطلة.",
    "Sulla maggior parte dei PC questo è già acceso — il tuo semplicemente è spento."
  ],
  [
    "On the agent box, set \"Inference source\" → Remote, host = this PC's IP, port = the model's server port above, and paste this key.",
    "在代理设备上，设置“推理来源” → 远程，主机 = 这台电脑的 IP，端口 = 上述模型服务器端口，然后粘贴这个密钥。",
    "에이전트 박스에서 \"Inference source\" → Remote로 설정하고, 호스트 = 이 PC의 IP, 포트 = 위 모델의 서버 포트, 그리고 이 키를 붙여넣으세요.",
    "エージェントボックスで、「推論元」をリモートに設定し、ホスト = このPCのIP、ポート = 上記のモデルサーバーポート、そしてこのキーを貼り付けます。",
    "على صندوق الوكيل، قم بتعيين \"مصدر الاستدلال\" → عن بُعد، المضيف = عنوان IP لهذا الكمبيوتر، المنفذ = منفذ خادم النموذج أعلاه، والصق هذا المفتاح.",
    "Nella casella dell'agente, impostare \"Sorgente di inferenza\" → Remoto, host = l'IP di questo PC, porta = la porta del server del modello sopra, e incollare questa chiave."
  ],
  [
    "on this machine. Agents fall back to the CLI subscription automatically when no key is saved.",
    "在这台机器上开启。当没有保存密钥时，代理会自动回退到CLI订阅。",
    "이 머신에서 켜기. 키가 저장되지 않은 경우 에이전트는 자동으로 CLI 구독으로 돌아갑니다.",
    "このマシンでオン。キーが保存されていない場合、エージェントは自動的にCLIサブスクリプションにフォールバックします。",
    "على هذا الجهاز. يعود الوكلاء تلقائيًا إلى اشتراك CLI عند عدم حفظ أي مفتاح.",
    "su questo computer. Gli agenti ricorrono automaticamente alla sottoscrizione CLI quando nessuna chiave è salvata."
  ],
  [
    "on this PC. The defaults below are fine; change them if you like.",
    "在这台电脑上。下面的默认设置是可以的；如果你愿意可以更改它们。",
    "이 PC에서. 아래 기본값으로도 괜찮습니다; 원하면 변경하세요. ",
    "このPCで。以下のデフォルトで問題ありません。必要なら変更してください。",
    "على هذا الكمبيوتر. الإعدادات الافتراضية أدناه جيدة؛ غيّرها إذا أحببت.",
    "su questo PC. Le impostazioni predefinite di seguito vanno bene; cambiale se vuoi."
  ],
  [
    "On Windows these run inside WSL/Ubuntu. Install the one you want, then it's picked automatically when you Start a training run. torch auto-matches your GPU.",
    "在 Windows 上，这些运行在 WSL/Ubuntu 内。安装你想要的，然后在开始训练运行时会自动选择。torch 会自动匹配你的 GPU。",
    "Windows에서는 WSL/Ubuntu 안에서 실행됩니다. 원하는 것을 설치하면 학습 실행을 시작할 때 자동으로 선택됩니다. torch가 GPU를 자동으로 매치합니다. ",
    "Windowsでは、これらはWSL/Ubuntu内で実行されます。希望するものをインストールすると、トレーニングを開始するときに自動的に選択されます。torchはGPUを自動で認識します。",
    "على نظام ويندوز، تعمل هذه بداخل WSL/Ubuntu. قم بتثبيت ما تريد، ثم يتم اختياره تلقائيًا عند بدء تشغيل التدريب. يقوم torch بمطابقة معالج الرسوميات الخاص بك تلقائيًا.",
    "Su Windows questi vengono eseguiti all'interno di WSL/Ubuntu. Installa quello che desideri, poi sarà selezionato automaticamente quando avvii una sessione di addestramento. Torch abbina automaticamente la tua GPU."
  ],
  [
    "On: trims the screen recording down to just the OWLLM app + frame. Off: keeps the whole screen.",
    "开启：将屏幕录制剪辑到仅包含 OWLLM 应用程序及其窗口。关闭：保留整个屏幕。",
    "켜기: 화면 녹화를 OWLLM 앱 + 프레임으로만 잘라냅니다. 끄기: 전체 화면을 유지합니다. ",
    "オン：画面録画をOWLLMアプリとフレームだけにトリミングします。オフ：画面全体を保持します。",
    "تشغيل: يقص تسجيل الشاشة ليظهر فقط تطبيق OWLLM + الإطار. إيقاف: يحافظ على الشاشة كاملة.",
    "On: riduce la registrazione dello schermo solo all'app OWLLM + cornice. Off: mantiene l'intero schermo."
  ],
  [
    "One click installs everything automatically. Windows will show a",
    "一键自动安装所有内容。Windows 会显示一个",
    "원클릭으로 모든 것을 자동으로 설치합니다. Windows가 표시할 것입니다. ",
    "ワンクリックで全て自動的にインストールされます。Windowsは",
    "نقرة واحدة لتثبيت كل شيء تلقائيًا. سيعرض ويندوز",
    "Un clic installa tutto automaticamente. Windows mostrerà un"
  ],
  [
    "One line of context for the team to start with.",
    "为团队提供一行起始上下文。",
    "팀이 시작할 수 있는 한 줄의 컨텍스트. ",
    "チームが始めるための1行のコンテキスト。",
    "سطر واحد من السياق للفريق للبدء منه.",
    "Una riga di contesto da cui il team può partire."
  ],
  [
    "One of: desktop, iphone, android, tablet.",
    "以下之一：桌面、iPhone、安卓、平板。",
    "다음 중 하나: 데스크톱, 아이폰, 안드로이드, 태블릿. ",
    "次のうちのいずれか：デスクトップ、iPhone、Android、タブレット。",
    "أحد الخيارات: سطح المكتب، الآيفون، الأندرويد، الجهاز اللوحي.",
    "Uno di: desktop, iphone, android, tablet."
  ],
  [
    "One of: screenshot | type | keys | mouse | boot_key | mount_iso | power.",
    "以下之一：截图 | 类型 | 键 | 鼠标 | 启动键 | 挂载 ISO | 电源。",
    "다음 중 하나: 스크린샷 | 입력 | 키 | 마우스 | 부팅 키 | ISO 마운트 | 전원. ",
    "次のうちのいずれか：スクリーンショット | タイプ | キー | マウス | 起動キー | ISOマウント | 電源。",
    "أحد الخيارات: لقطة شاشة | كتابة | مفاتيح | الفأرة | مفتاح التشغيل | تركيب ISO | الطاقة.",
    "Uno di: screenshot | type | keys | mouse | boot_key | mount_iso | power."
  ],
  [
    "one restart",
    "一次重启",
    "한 번 재시작 ",
    "再起動1回",
    "إعادة تشغيل واحدة",
    "un riavvio"
  ],
  [
    "online",
    "在线",
    "온라인",
    "オンライン",
    "متصل بالإنترنت",
    "online"
  ],
  [
    "only bumps, commits, tags and pushes; the repo workflow builds and publishes it (no local build toolchain needed, but GitHub Actions must be enabled and billed).",
    "只有版本更新、提交、标签和推送；仓库工作流会构建并发布它（不需要本地构建工具链，但必须启用并计费 GitHub Actions）。",
    "단지 버전 올림, 커밋, 태그, 푸시만; 레포 워크플로우가 이를 빌드하고 배포합니다(로컬 빌드 도구 체인은 필요하지 않지만, GitHub Actions가 활성화되고 과금되어야 합니다).",
    "バンプ、コミット、タグ、プッシュのみで済みます；リポジトリのワークフローがビルドして公開します（ローカルのビルドツールチェーンは不要ですが、GitHub Actionsを有効にして請求設定が必要です）。",
    "فقط التحديثات، الالتزامات، العلامات والدفع؛ يقوم سير عمل المستودع ببنائها ونشرها (لا حاجة لأدوات بناء محلية، لكن يجب تفعيل GitHub Actions وسيتم تحصيل الرسوم).",
    "solo aggiornamenti di versione, commit, tag e push; il flusso di lavoro del repository lo costruisce e lo pubblica (nessuno strumento di build locale necessario, ma GitHub Actions deve essere abilitato e fatturato)."
  ],
  [
    "Only do this for a project and agents you trust. You can turn it back off at any time.",
    "仅对你信任的项目和代理执行此操作。你可以随时关闭它。",
    "이 작업은 신뢰하는 프로젝트와 에이전트에 대해서만 수행하세요. 언제든지 다시 끌 수 있습니다.",
    "信頼できるプロジェクトとエージェントに対してのみ行ってください。いつでも無効に戻すことができます。",
    "قم بذلك فقط لمشروع ووكلاء تثق بهم. يمكنك إيقافه في أي وقت.",
    "Fallo solo per un progetto e agenti di cui ti fidi. Puoi disattivarlo in qualsiasi momento."
  ],
  [
    "Only needed when your Authenticode cert lives in Certum's cloud.",
    "仅在你的 Authenticode 证书存放在 Certum 云端时需要。",
    "이 기능은 Authenticode 인증서가 Certum의 클라우드에 있을 때만 필요합니다.",
    "Authenticode証明書がCertumのクラウドにある場合にのみ必要です。",
    "مطلوب فقط عندما يكون شهادة Authenticode الخاصة بك موجودة في سحابة Certum.",
    "Necessario solo quando il tuo certificato Authenticode risiede nel cloud di Certum."
  ],
  [
    "Open",
    "打开",
    "열기",
    "開く",
    "فتح",
    "Apri"
  ],
  [
    "Open {0} to sign up / get your key",
    "打开 {0} 来注册 / 获取你的密钥",
    "가입/키 받기를 위해 {0} 열기",
    "サインアップ/キー取得のために{0}を開く",
    "افتح {0} للتسجيل / الحصول على مفتاحك",
    "Apri {0} per registrarti / ottenere la tua chiave"
  ],
  [
    "Open a guide explaining how to wire this API into Cursor / VS Code.",
    "打开一个指南，解释如何将此 API 接入 Cursor / VS Code。",
    "Cursor / VS Code에 이 API를 연결하는 방법을 설명하는 가이드 열기",
    "Cursor / VS CodeにこのAPIを組み込む方法を説明するガイドを開く",
    "افتح دليل يشرح كيفية توصيل هذه الواجهة البرمجية بـ Cursor / VS Code.",
    "Apri una guida che spiega come collegare questa API a Cursor / VS Code."
  ],
  [
    "Open a live interactive shell on the target (SSH-like)",
    "在目标上打开一个实时交互式 shell（类似 SSH）",
    "대상에서 라이브 인터랙티브 셸 열기 (SSH 유사)",
    "ターゲット上でライブの対話型シェルを開く（SSHのようなもの）",
    "افتح قشرة تفاعلية حية على الهدف (مثل SSH)",
    "Apri una shell interattiva live sul target (simile a SSH)"
  ],
  [
    "Open a new page — pick or create a project (each page gets its own branch/worktree), or just chat",
    "打开一个新页面——选择或创建一个项目（每个页面都有自己的分支/工作树），或者只是聊天",
    "새 페이지를 열기 — 프로젝트를 선택하거나 생성하기(각 페이지는 자체 브랜치/작업 트리를 갖습니다), 또는 그냥 채팅하기",
    "新しいページを開く — プロジェクトを選ぶか作成する（各ページは独自のブランチ/ワークツリーを持つ）、または単にチャットする",
    "افتح صفحة جديدة — اختر أو أنشئ مشروعًا (كل صفحة تحصل على فرع/شجرة عمل خاصة بها)، أو فقط دردش",
    "Apri una nuova pagina — scegli o crea un progetto (ogni pagina ottiene il proprio branch/worktree), oppure semplicemente chatta"
  ],
  [
    "Open a project folder",
    "打开项目文件夹",
    "프로젝트 폴더 열기",
    "プロジェクトフォルダーを開く",
    "افتح مجلد المشروع",
    "Apri una cartella di progetto"
  ],
  [
    "Open a project folder…",
    "打开一个项目文件夹…",
    "프로젝트 폴더 열기…",
    "プロジェクトフォルダを開く…",
    "افتح مجلد مشروع…",
    "Apri una cartella di progetto…"
  ],
  [
    "Open a project to see its team memory.",
    "打开项目以查看其团队记忆。",
    "프로젝트를 열어 팀 메모리 보기",
    "チームメモリを見るためにプロジェクトを開く。",
    "افتح مشروعًا لرؤية ذاكرة الفريق الخاصة به.",
    "Apri un progetto per vedere la memoria del team."
  ],
  [
    "Open a terminal in the workspace folder — floats above the app (this app only). Drag its title bar to move it; — hides it without killing the shell.",
    "在工作区文件夹中打开终端 —— 浮在应用程序上方（仅限此应用）。拖动标题栏即可移动；—— 隐藏它而不杀死 shell。",
    "작업 공간 폴더에서 터미널 열기 — 앱 위에 떠 있음(이 앱 전용). 제목 표시줄을 드래그하여 이동 가능; — 셸을 종료하지 않고 숨기기.",
    "ワークスペースフォルダでターミナルを開く — アプリの上に浮かぶ（このアプリのみ）。タイトルバーをドラッグして移動できる; — シェルを終了せずに非表示にする。",
    "افتح محطة طرفية في مجلد مساحة العمل — تطفو فوق التطبيق (هذا التطبيق فقط). اسحب شريط العنوان لتحريكه؛ — يخفيه دون إنهاء الصدفة.",
    "Apri un terminale nella cartella di lavoro — fluttua sopra l'app (solo questa app). Trascina la barra del titolo per spostarlo; — lo nasconde senza terminare la shell."
  ],
  [
    "open a URL (e.g. github.com) — agents inherit this session",
    "打开一个 URL（例如 github.com）—— 代理继承此会话",
    "URL 열기 (예: github.com) — 에이전트가 이 세션을 상속함",
    "URLを開く（例: github.com） — エージェントがこのセッションを引き継ぐ",
    "افتح عنوان URL (مثال: github.com) — العملاء يرثون هذه الجلسة",
    "apri un URL (es. github.com) — gli agenti ereditano questa sessione"
  ],
  [
    "Open a URL in the REAL persistent browser — a native OwLLM browser window",
    "在真实的持久浏览器中打开 URL —— 一个原生的 OwLLM 浏览器窗口",
    "실제 지속 브라우저에서 URL 열기 — 네이티브 OwLLM 브라우저 창",
    "リアルな永続ブラウザでURLを開く — ネイティブのOwLLMブラウザウィンドウ",
    "افتح عنوان URL في المتصفح الدائم الحقيقي — نافذة متصفح أصلية لـ OwLLM",
    "Apri un URL nel browser persistente REALE — una finestra del browser nativa di OwLLM"
  ],
  [
    "Open another Agents page — run a team on the same or a different project in parallel",
    "打开另一个代理页面 —— 在同一项目或不同项目上并行运行一个团队",
    "다른 에이전트 페이지 열기 — 같은 프로젝트 또는 다른 프로젝트에서 팀을 병행하여 실행",
    "別のエージェントページを開く — 同じまたは別のプロジェクトでチームを並行して実行する",
    "افتح صفحة عملاء أخرى — قم بتشغيل فريق على نفس المشروع أو مشروع مختلف بالتوازي",
    "Apri un'altra pagina Agenti — esegui un team sullo stesso progetto o su un progetto diverso in parallelo"
  ],
  [
    "Open Apple portal",
    "打开 Apple 门户",
    "Apple 포털 열기",
    "Appleポータルを開く",
    "افتح بوابة Apple",
    "Apri il portale Apple"
  ],
  [
    "Open Certum panel",
    "打开 Certum 面板",
    "Certum 패널 열기",
    "Certumパネルを開く",
    "افتح لوحة Certum",
    "Apri il pannello Certum"
  ],
  [
    "Open folder",
    "打开文件夹",
    "폴더 열기",
    "フォルダーを開く",
    "افتح المجلد",
    "Apri cartella"
  ],
  [
    "Open page",
    "打开页面",
    "페이지 열기",
    "ページを開く",
    "افتح الصفحة",
    "Apri pagina"
  ],
  [
    "Open Server Control",
    "打开服务器控制",
    "서버 제어 열기",
    "サーバーコントロールを開く",
    "فتح التحكم بالخادم",
    "Apri il Controllo Server"
  ],
  [
    "Open signed-in",
    "打开已登录",
    "로그인 상태 열기",
    "サインイン済みを開く",
    "فتح تسجيل الدخول",
    "Apri accesso effettuato"
  ],
  [
    "Open Skill Library",
    "打开技能库",
    "스킬 라이브러리 열기",
    "スキルライブラリを開く",
    "فتح مكتبة المهارات",
    "Apri la Libreria di Competenze"
  ],
  [
    "Open subscription",
    "开放订阅",
    "구독 열기",
    "オープン購読",
    "فتح الاشتراك",
    "Abbonamento aperto"
  ],
  [
    "Open the Bridges configurator",
    "打开桥接配置器",
    "브리지 구성기를 엽니다",
    "ブリッジ構成ツールを開く",
    "فتح مُكوّن الجسور",
    "Apri il configuratore Bridges"
  ],
  [
    "Open the fine-tuning environments dialog",
    "打开微调环境对话框",
    "미세 조정 환경 대화상자를 엽니다",
    "ファインチューニング環境ダイアログを開く",
    "فتح مربع حوار بيئات الضبط الدقيق",
    "Apri la finestra di dialogo degli ambienti di fine-tuning"
  ],
  [
    "Open the per-agent chat grid in this canvas (every agent gets its own live transcript window)",
    "在此画布中打开每个代理的聊天网格（每个代理都有自己的实时记录窗口）",
    "이 캔버스에서 에이전트별 채팅 그리드를 엽니다 (모든 에이전트는 자신의 실시간 기록 창을 갖습니다)",
    "このキャンバスでエージェントごとのチャットグリッドを開く（各エージェントに独自のライブトランスクリプトウィンドウが付与されます）",
    "فتح شبكة الدردشة لكل عميل في هذه اللوحة (كل عميل يحصل على نافذة نسخة حية خاصة به)",
    "Apri la griglia di chat per agente in questa tela (ogni agente ottiene la propria finestra di trascrizione in tempo reale)"
  ],
  [
    "Open the Rules sub-tab (Super User page)",
    "打开规则子选项卡（超级用户页面）",
    "규칙 하위 탭을 엽니다 (슈퍼 유저 페이지)",
    "ルールのサブタブを開く（スーパーユーザーページ）",
    "فتح علامة التبويب الفرعية للقواعد (صفحة المستخدم المتميز)",
    "Apri la sotto-scheda Regole (pagina Super Utente)"
  ],
  [
    "Open the Server modal",
    "打开服务器模态",
    "서버 모달을 엽니다",
    "サーバーモーダルを開く",
    "فتح نافذة خادم",
    "Apri il modale del Server"
  ],
  [
    "Open the team workbench",
    "打开团队工作台",
    "팀 작업대를 엽니다",
    "チームワークベンチを開く",
    "فتح منصة عمل الفريق",
    "Apri il banco di lavoro del team"
  ],
  [
    "Open the Team Workbench — assign leaders, wire who dispatches to whom, equip skills",
    "打开团队工作台 — 分配领导者，安排谁向谁调度，配备技能",
    "팀 작업대 열기 — 리더 지정, 누가 누구에게 파견하는지 연결, 기술 장비",
    "チーム作業台を開く — リーダーを割り当て、誰が誰に指示するかを配線し、スキルを装備する",
    "افتح ورشة عمل الفريق — عين القادة، وحدد من يرسل إلى من، وجهز المهارات",
    "Apri il Team Workbench — assegna i leader, collega chi invia a chi, attrezza le competenze"
  ],
  [
    "Open the team workbench — editing a built-in saves a custom copy",
    "打开团队工作台 — 编辑内置内容会保存为自定义副本",
    "팀 작업대 열기 — 내장 편집은 사용자 정의 복사본 저장",
    "チーム作業台を開く — 組み込みのものを編集するとカスタムコピーが保存される",
    "افتح ورشة عمل الفريق — تعديل المدمج يحفظ نسخة مخصصة",
    "Apri il team workbench — modificare un integrato salva una copia personalizzata"
  ],
  [
    "Open this site in the OwLLM browser and sign in.",
    "在OwLLM浏览器中打开此网站并登录。",
    "OwLLM 브라우저에서 이 사이트를 열고 로그인합니다.",
    "このサイトをOwLLMブラウザで開き、サインインしてください。",
    "افتح هذا الموقع في متصفح OwLLM وسجّل الدخول.",
    "Apri questo sito nel browser OwLLM e accedi."
  ],
  [
    "OpenAI",
    "OpenAI",
    "오픈AI",
    "オープンAI",
    "أوبن أي آي",
    "OpenAI"
  ],
  [
    "OPENAI",
    "OPENAI",
    "OPENAI",
    "OPENAI",
    "OPENAI",
    "OPENAI"
  ],
  [
    "OpenAI API:",
    "OpenAI API:",
    "OpenAI API:",
    "OpenAI API:",
    "واجهة برمجة تطبيقات OpenAI:",
    "API OpenAI:"
  ],
  [
    "Opens Apple's certificate page in the OwLLM browser, signed in from your saved login.",
    "在OwLLM浏览器中打开苹果的证书页面，从您保存的登录信息登录。",
    "OwLLM 브라우저에서 Apple의 인증서 페이지를 열고, 저장된 로그인으로 로그인합니다.",
    "OwLLMブラウザでAppleの証明書ページを開き、保存されたログインからサインインします。",
    "يفتح صفحة شهادة Apple في متصفح OwLLM، مسجّل الدخول من تسجيلك المحفوظ.",
    "Apre la pagina del certificato Apple nel browser OwLLM, con accesso effettuato dal tuo login salvato."
  ],
  [
    "Opens appleid.apple.com in the OwLLM browser, signed in from your saved login.",
    "在OwLLM浏览器中打开 appleid.apple.com，从您保存的登录信息登录。",
    "OwLLM 브라우저에서 appleid.apple.com을 열고, 저장된 로그인으로 로그인합니다.",
    "OwLLMブラウザでappleid.apple.comを開き、保存されたログインからサインインします。",
    "يفتح appleid.apple.com في متصفح OwLLM، مسجّل الدخول من تسجيلك المحفوظ.",
    "Apre appleid.apple.com nel browser OwLLM, con accesso effettuato dal tuo login salvato."
  ],
  [
    "Opens Certum's panel (SimplySign / cert management) in the OwLLM browser, signed in from your saved login.",
    "在OwLLM浏览器中打开 Certum 的面板（SimplySign / 证书管理），从您保存的登录信息登录。",
    "OwLLM 브라우저에서 Certum의 패널(SimplySign / 인증서 관리)을 열고, 저장된 로그인으로 로그인합니다.",
    "OwLLMブラウザでCertumのパネル（SimplySign / 証明書管理）を開き、保存されたログインからサインインします。",
    "يفتح لوحة Certum (SimplySign / إدارة الشهادات) في متصفح OwLLM، مسجّل الدخول من تسجيلك المحفوظ.",
    "Apre il pannello di Certum (SimplySign / gestione certificati) nel browser OwLLM, con accesso effettuato dal tuo login salvato."
  ],
  [
    "Opens GitHub in your browser — click Authorize and you’re in. Nothing to paste.",
    "在浏览器中打开 GitHub — 点击授权，你就可以进入。无需粘贴任何内容。",
    "브라우저에서 GitHub을 엽니다 — '승인'을 클릭하면 접속됩니다. 붙여넣을 것이 없습니다.",
    "GitHubをブラウザで開き、[Authorize]をクリックすれば完了です。貼り付けるものは何もありません。",
    "يفتح GitHub في متصفحك — انقر على تفويض وستكون داخل الحساب. لا حاجة للصق أي شيء.",
    "Apre GitHub nel tuo browser — clicca su Autorizza e sei dentro. Niente da incollare."
  ],
  [
    "Opens huggingface.co/settings/tokens in your browser. Create a READ token.",
    "在您的浏览器中打开 huggingface.co/settings/tokens。创建一个读取令牌。",
    "브라우저에서 huggingface.co/settings/tokens를 열고, READ 토큰을 생성합니다.",
    "ブラウザでhuggingface.co/settings/tokensを開きます。READトークンを作成してください。",
    "يفتح huggingface.co/settings/tokens في متصفحك. أنشئ رمز READ.",
    "Apre huggingface.co/settings/tokens nel tuo browser. Crea un token READ."
  ],
  [
    "openssl missing",
    "缺少 openssl",
    "openssl 없음",
    "opensslがありません",
    "openssl مفقود",
    "openssl mancante"
  ],
  [
    "openssl ok",
    "openssl 正常",
    "openssl 정상",
    "opensslは問題ありません",
    "openssl بخير",
    "openssl ok"
  ],
  [
    "Optional — refines the base role for this team.",
    "可选 — 精炼此团队的基础角色。",
    "선택 사항 — 이 팀의 기본 역할을 세분화합니다.",
    "オプション — このチームの基本役割を洗練します。",
    "اختياري — يصقل الدور الأساسي لهذا الفريق.",
    "Opzionale — affina il ruolo di base per questo team."
  ],
  [
    "Optional comma-separated tags to aid later search.",
    "可选的逗号分隔标签以便后期搜索。",
    "선택 사항으로 나중에 검색을 돕기 위한 쉼표로 구분된 태그들.",
    "後で検索を助けるための、カンマ区切りのタグ（オプション）。",
    "علامات اختيارية مفصولة بفواصل لتسهيل البحث لاحقًا.",
    "Tag opzionali separati da virgola per facilitare la ricerca successiva."
  ],
  [
    "Optional notes…",
    "可选备注…",
    "선택 사항 노트…",
    "オプションのメモ…",
    "ملاحظات اختيارية…",
    "Note opzionali…"
  ],
  [
    "Optional page name — the tab shows {0}(name), e.g. {1}(GUI_fix). Leave empty to show the folder name only.",
    "可选页面名称 — 标签显示 {0}(名称)，例如 {1}(GUI_fix)。留空将只显示文件夹名称。",
    "선택 사항 페이지 이름 — 탭에 {0}(이름)이 표시됩니다, 예: {1}(GUI_fix). 빈칸으로 두면 폴더 이름만 표시됩니다.",
    "オプションのページ名 — タブに {0}(名前) が表示されます。例：{1}(GUI_fix)。フォルダ名だけを表示する場合は空欄のままにしてください。",
    "اسم الصفحة الاختياري — يعرض التبويب {0}(الاسم)، على سبيل المثال {1}(GUI_fix). اتركه فارغًا لعرض اسم المجلد فقط.",
    "Nome pagina opzionale — la scheda mostra {0}(nome), ad esempio {1}(GUI_fix). Lascia vuoto per mostrare solo il nome della cartella."
  ],
  [
    "Optional stable id to upsert in place (e.g. 'build_command', 'api_base_url').",
    "可选稳定 ID，可用于就地更新（例如 'build_command', 'api_base_url'）。",
    "업데이트할 선택적 안정 ID(예: 'build_command', 'api_base_url').",
    "アップサート用のオプションの安定ID（例: 'build_command', 'api_base_url'）。",
    "معرف ثابت اختياري للتحديث في مكانه (مثال 'build_command', 'api_base_url').",
    "ID stabile opzionale da inserire o aggiornare sul posto (es. 'build_command', 'api_base_url')."
  ],
  [
    "or",
    "或",
    "또는",
    "または",
    "أو",
    "o"
  ],
  [
    "or development on another of your machines. Returns stdout/stderr/exit_code. Requires",
    "或在您的另一台机器上进行开发。返回 stdout/stderr/exit_code。需要",
    "또는 다른 기기에서 개발. stdout/stderr/exit_code 반환. 필요함",
    "または、別のマシンでの開発。stdout/stderr/exit_code を返します。必要条件",
    "أو التطوير على جهاز آخر لديك. يُرجع stdout/stderr/exit_code. يتطلب",
    "o sviluppo su un altro dei tuoi computer. Restituisce stdout/stderr/exit_code. Richiede"
  ],
  [
    "Or start from a local folder",
    "或者从本地文件夹开始",
    "로컬 폴더에서 시작",
    "またはローカルフォルダから開始",
    "أو ابدأ من مجلد محلي",
    "Oppure inizia da una cartella locale"
  ],
  [
    "orch",
    "orch",
    "orchestr",
    "オルチ",
    "orch",
    "orch"
  ],
  [
    "Orchestrated Team",
    "编排团队",
    "조직된 팀",
    "オーケストレーションされたチーム",
    "فريق مُنسّق",
    "Team Orchestrato"
  ],
  [
    "Orchestrated Workflow",
    "编排工作流",
    "조직된 워크플로",
    "オーケストレーションされたワークフロー",
    "سير عمل مُنسّق",
    "Flusso di lavoro Orchestrato"
  ],
  [
    "orchestrator",
    "编排者",
    "오케스트레이터",
    "オーケストレーター",
    "منسق",
    "orchestratore"
  ],
  [
    "Orchestrator",
    "协调者",
    "오케스트라 지휘자",
    "オーケストレーター",
    "منسق",
    "Direttore d'orchestra"
  ],
  [
    "orchestrator batches independent tasks into one wave",
    "协调器将独立任务批处理为一个波次",
    "오케스트레이터는 독립적인 작업을 하나의 웨이브로 배치함",
    "オーケストレーターは独立したタスクを1つの波にまとめます",
    "يقوم المنسق بتجميع المهام المستقلة في موجة واحدة",
    "l'orchestratore raggruppa compiti indipendenti in un'unica ondata"
  ],
  [
    "Order by:",
    "排序方式：",
    "정렬 기준:",
    "並べ替え:",
    "الترتيب حسب:",
    "Ordina per:"
  ],
  [
    "Orthogonalizes every",
    "正交化每个",
    "모든 것을 직교화합니다",
    "すべて直交化します",
    "يعمد كل",
    "Ortogonalizza ogni"
  ],
  [
    "OTHER",
    "其他",
    "다른",
    "その他",
    "آخر",
    "ALTRO"
  ],
  [
    "Other cleanup",
    "其他清理",
    "다른 정리",
    "その他のクリーンアップ",
    "تنظيف آخر",
    "Altra pulizia"
  ],
  [
    "output",
    "输出",
    "출력",
    "出力",
    "الإخراج",
    "OUTPUT"
  ],
  [
    "Output",
    "输出",
    "출력",
    "出力",
    "المخرجات",
    "Uscita"
  ],
  [
    "OUTPUT",
    "输出",
    "출력",
    "出力",
    "المخرجات",
    "USCITA"
  ],
  [
    "Output will appear here once you click Run Brainstorm.",
    "点击运行头脑风暴后，输出将显示在此处。",
    "실행 브레인스토밍을 클릭하면 여기에 출력이 나타납니다.",
    "「ブレインストームを実行」をクリックすると、出力がここに表示されます。",
    "سيظهر الإخراج هنا بمجرد النقر على تشغيل العصف الذهني.",
    "L'output apparirà qui una volta cliccato Esegui Brainstorm."
  ],
  [
    "Output:",
    "输出：",
    "출력:",
    "出力:",
    "الإخراج:",
    "Output:"
  ],
  [
    "outside the project folder:",
    "在项目文件夹之外：",
    "프로젝트 폴더 외부:",
    "プロジェクトフォルダの外側:",
    "خارج مجلد المشروع:",
    "fuori dalla cartella del progetto:"
  ],
  [
    "outside the project folder.",
    "在项目文件夹之外。",
    "프로젝트 폴더 외부.",
    "プロジェクトフォルダの外側。",
    "خارج مجلد المشروع.",
    "fuori dalla cartella del progetto."
  ],
  [
    "Overlap",
    "重叠",
    "겹침",
    "重複",
    "تداخل",
    "Sovrapposizione"
  ],
  [
    "Override is saved per-project. Click 🔄 Reset to restore the role's default.",
    "覆盖是按项目保存的。点击 🔄 重置以恢复角色的默认设置。",
    "재정의는 프로젝트별로 저장됩니다. 🔄 초기화를 클릭하여 역할의 기본값을 복원하세요.",
    "オーバーライドはプロジェクトごとに保存されます。役割のデフォルトに戻すには、🔄 リセットをクリックしてください。",
    "يتم حفظ التجاوز لكل مشروع. انقر 🔄 إعادة لضبط الدور إلى الإعداد الافتراضي.",
    "La sovrascrittura viene salvata per progetto. Clicca 🔄 Reimposta per ripristinare il ruolo predefinito."
  ],
  [
    "Override the canvas team",
    "覆盖画布团队",
    "캔버스 팀 재정의",
    "キャンバスチームをオーバーライド",
    "تجاوز فريق اللوحة",
    "Sovrascrivi il team del canvas"
  ],
  [
    "OWLLM",
    "OWLLM",
    "OWLLM",
    "OWLLM",
    "OWLLM",
    "OWLLM"
  ],
  [
    "OwLLM Code",
    "OwLLM 代码",
    "OwLLM 코드",
    "OwLLM コード",
    "رمز OwLLM",
    "Codice OwLLM"
  ],
  [
    "OwLLM creates the private key (kept encrypted on this machine) and a",
    "OwLLM 创建私钥（保存在此机器上加密）和一个",
    "OwLLM은 개인 키를 생성합니다(이 컴퓨터에 암호화되어 저장됨).",
    "OwLLM はプライベートキーを作成します（このマシン上で暗号化されたまま保持されます）および",
    "يقوم OwLLM بإنشاء المفتاح الخاص (يتم الاحتفاظ به مشفرًا على هذه الآلة) و",
    "OwLLM crea la chiave privata (mantenuta criptata su questa macchina) e una"
  ],
  [
    "OwLLM Desktop · Update available",
    "OwLLM 桌面 · 有可用更新",
    "OwLLM 데스크탑 · 업데이트 가능  ",
    "OwLLM デスクトップ · 更新があります",
    "سطح مكتب OwLLM · التحديث متاح",
    "OwLLM Desktop · Aggiornamento disponibile"
  ],
  [
    "OWLLM_SIGN_*",
    "OWLLM_SIGN_*",
    "OWLLM_서명_*",
    "OWLLM_SIGN_*",
    "OWLLM_SIGN_*",
    "OWLLM_SIGN_*"
  ],
  [
    "owllm-vault",
    "owllm-vault",
    "owllm-저장소",
    "owllm-ボールト",
    "خزنة owllm",
    "owllm-vault"
  ],
  [
    "owner (e.g. ruigro)",
    "所有者（例如 ruigro）",
    "소유자 (예: ruigro)",
    "所有者（例：ruigro）",
    "المالك (مثال: ruigro)",
    "proprietario (es. ruigro)"
  ],
  [
    "owner/model — e.g. unsloth/Llama-3.2-3B-Instruct-bnb-4bit",
    "所有者/模型 — 例如 unsloth/Llama-3.2-3B-Instruct-bnb-4bit",
    "  \nowner/model — 예: unsloth/Llama-3.2-3B-Instruct-bnb-4bit  ",
    "所有者/モデル — 例: unsloth/Llama-3.2-3B-Instruct-bnb-4bit",
    "مالك/نموذج — على سبيل المثال unsloth/Llama-3.2-3B-Instruct-bnb-4bit",
    "proprietario/modello — es. unsloth/Llama-3.2-3B-Instruct-bnb-4bit"
  ],
  [
    "owner/name — empty = publish script's default",
    "所有者/名称 — 空 = 使用发布脚本的默认值",
    "  \nowner/name — 비어 있음 = 스크립트의 기본값 사용",
    "所有者/名前 — 空欄 = スクリプトのデフォルトを公開",
    "مالك/اسم — فارغ = الافتراضي لبرنامج النشر",
    "proprietario/nome — vuoto = predefinito dello script di pubblicazione"
  ],
  [
    "pack",
    "打包",
    "팩",
    "パック",
    "حزمة",
    "pacchetto"
  ],
  [
    "page and it's mirrored here automatically.",
    "页面及其内容在此自动镜像。",
    "페이지와 이것은 자동으로 여기에도 미러됩니다.",
    "ページとその内容はここに自動的にミラーされます。",
    "الصفحة ومُعكوسة هنا تلقائيًا.",
    "pagina e qui viene mirrorata automaticamente."
  ],
  [
    "Page not ported yet",
    "页面尚未移植",
    "아직 포트되지 않은 페이지",
    "ページはまだ移植されていません",
    "الصفحة لم تُنقل بعد",
    "Pagina non ancora portata"
  ],
  [
    "Pair",
    "配对",
    "페어",
    "ペア",
    "زوج",
    "Coppia"
  ],
  [
    "Pair (self-test)",
    "配对（自检）",
    "페어 (자체 테스트)",
    "ペア（自己テスト）",
    "زوج (اختبار ذاتي)",
    "Coppia (autoverifica)"
  ],
  [
    "pair by ip:port (e.g. 192.168.1.5:47771)",
    "按 ip:端口 配对（例如 192.168.1.5:47771）",
    "ip:포트로 페어링 (예: 192.168.1.5:47771)",
    "IP:ポートによるペア（例：192.168.1.5:47771）",
    "الاقتران بواسطة ip:port (مثال: 192.168.1.5:47771)",
    "coppia tramite ip:porta (es. 192.168.1.5:47771)"
  ],
  [
    "Pairing request — approval required",
    "配对请求——需要批准",
    "페어링 요청 — 승인 필요  ",
    "ペアリングリクエスト — 承認が必要",
    "طلب الاقتران — الموافقة مطلوبة",
    "Richiesta di associazione — approvazione richiesta"
  ],
  [
    "Pairs / chunk",
    "配对 / 块",
    "페어 / 청크",
    "ペア / チャンク",
    "أزواج / جزء",
    "Coppie / blocco"
  ],
  [
    "Palette",
    "调色板",
    "팔레트",
    "パレット",
    "لوحة الألوان",
    "Palette"
  ],
  [
    "parallel dispatch (run independent agents at once)",
    "并行调度（同时运行独立代理）",
    "병렬 디스패치 (독립 에이전트를 동시에 실행)",
    "並列ディスパッチ（複数のエージェントを同時に実行）",
    "التوزيع المتوازي (تشغيل وكلاء مستقلين في وقت واحد)",
    "invio parallelo (eseguire agenti indipendenti contemporaneamente)"
  ],
  [
    "pass",
    "通过",
    "패스",
    "パス",
    "تجاوز",
    "passa"
  ],
  [
    "Pass an empty query to see the most recent entries.",
    "传递一个空查询以查看最近的条目。",
    "가장 최근 항목을 보려면 빈 쿼리를 전달하세요.",
    "最新のエントリを見るには空のクエリを送信してください。",
    "مرر استعلامًا فارغًا لرؤية أحدث الإدخالات.",
    "Invia una query vuota per vedere le voci più recenti."
  ],
  [
    "password",
    "密码",
    "비밀번호",
    "パスワード",
    "كلمة المرور",
    "Password"
  ],
  [
    "Password",
    "密码",
    "비밀번호",
    "パスワード",
    "كلمة المرور",
    "Password"
  ],
  [
    "Past conversations",
    "历史对话",
    "과거 대화",
    "過去の会話",
    "المحادثات السابقة",
    "Conversazioni passate"
  ],
  [
    "paste",
    "粘贴",
    "붙여넣기",
    "貼り付け",
    "لصق",
    "incolla"
  ],
  [
    "Paste a GitHub token so agents can clone private repos and push from inside the sandbox.",
    "粘贴 GitHub 令牌，以便代理可以克隆私人仓库并在沙箱内推送。",
    "에이전트가 사설 저장소를 클론하고 샌드박스 내에서 푸시할 수 있도록 GitHub 토큰을 붙여넣으세요.",
    "エージェントがプライベートリポジトリをクローンし、サンドボックス内からプッシュできるように、GitHubトークンを貼り付けてください。",
    "الصق رمز GitHub حتى يتمكن الوكلاء من استنساخ المستودعات الخاصة والدفع من داخل صندوق الرمال.",
    "Incolla un token GitHub così gli agenti possono clonare repository privati e fare push dall'interno del sandbox."
  ],
  [
    "Paste a URL and press Enter…",
    "粘贴 URL 并按回车…",
    "  \nURL을 붙여넣고 Enter 키를 누르세요…  ",
    "URLを貼り付けてEnterキーを押してください…",
    "الصق عنوان URL واضغط Enter…",
    "Incolla un URL e premi Invio…"
  ],
  [
    "paste key here",
    "在此处粘贴密钥",
    "여기에 키 붙여넣기",
    "ここにキーを貼り付け",
    "الصق المفتاح هنا",
    "incolla la chiave qui"
  ],
  [
    "Paste your",
    "粘贴你的",
    "당신의",
    "貼り付け",
    "الصق الخاص بك",
    "Incolla il tuo"
  ],
  [
    "Paste your read token here (starts with hf_…)",
    "在此粘贴您的读取令牌（以 hf_ 开头…）",
    "  \n여기에 읽기 토큰을 붙여넣으세요 (hf_로 시작…)",
    "ここに読み取りトークンを貼り付けてください（hf_で始まります…）",
    "الصق رمز القراءة الخاص بك هنا (يبدأ بـ hf_…)",
    "Incolla qui il tuo token di lettura (inizia con hf_…)"
  ],
  [
    "Path to gcp-oauth.keys.json downloaded from a Google Cloud OAuth client (web app type). See README.",
    "从 Google Cloud OAuth 客户端（Web 应用类型）下载的 gcp-oauth.keys.json 文件路径。请参阅 README。",
    "Google Cloud OAuth 클라이언트(웹 앱 유형)에서 다운로드한 gcp-oauth.keys.json 경로. README를 참조하세요.",
    "Google Cloud OAuthクライアント（ウェブアプリタイプ）からダウンロードしたgcp-oauth.keys.jsonへのパス。READMEを参照してください。",
    "مسار ملف gcp-oauth.keys.json الذي تم تنزيله من عميل OAuth في جوجل كلاود (نوع تطبيق ويب). انظر README.",
    "Percorso al file gcp-oauth.keys.json scaricato da un client OAuth di Google Cloud (tipo app web). Vedi README."
  ],
  [
    "Path to the file on the remote host.",
    "远程主机上的文件路径。",
    "원격 호스트의 파일 경로.",
    "リモートホスト上のファイルへのパス。",
    "مسار الملف على المضيف البعيد.",
    "Percorso del file sull'host remoto."
  ],
  [
    "Path to the JSON file where these settings are persisted.",
    "用于保存这些设置的 JSON 文件路径。",
    "이 설정이 저장되는 JSON 파일의 경로.",
    "これらの設定が保存されるJSONファイルへのパス。",
    "مسار ملف JSON حيث يتم حفظ هذه الإعدادات.",
    "Percorso del file JSON in cui queste impostazioni sono salvate."
  ],
  [
    "Path to the local file to send.",
    "要发送的本地文件路径。",
    "보낼 로컬 파일의 경로.",
    "送信するローカルファイルへのパス。",
    "مسار الملف المحلي للإرسال.",
    "Percorso del file locale da inviare."
  ],
  [
    "path you then view via the normal screenshot/vision path), 'type' (type a text string via",
    "然后通过正常的截图/视觉路径查看的路径）、'type'（通过输入文本字符串）",
    "일반 스크린샷/비전 경로를 통해 보는 경로), 'type' (텍스트 문자열을 입력)",
    "通常のスクリーンショット/ビジョンパスを通じて表示するパス）、 'type'（テキスト文字列を入力）",
    "المسار الذي تقوم بعد ذلك بعرضه عبر مسار لقطة الشاشة/الرؤية العادي)، 'type' (اكتب سلسلة نصية عبر",
    "percorso che poi visualizzi tramite il normale percorso screenshot/vision), 'type' (digita una stringa di testo tramite"
  ],
  [
    "Pause",
    "暂停",
    "일시 중지",
    "一時停止",
    "إيقاف مؤقت",
    "Pausa"
  ],
  [
    "paused",
    "已暂停",
    "일시 중지됨",
    "一時停止",
    "متوقف",
    "In pausa"
  ],
  [
    "Paused",
    "暂停",
    "일시 정지됨",
    "一時停止",
    "متوقف مؤقتًا",
    "In pausa"
  ],
  [
    "Paused.",
    "已暂停。",
    "일시 중지됨.",
    "一時停止中。",
    "متوقف.",
    "In pausa."
  ],
  [
    "PDF, DOCX, TXT, MD or web pages. They never leave your machine.",
    "PDF、DOCX、TXT、MD 或网页文件。它们永远不会离开您的计算机。",
    "PDF, DOCX, TXT, MD 또는 웹 페이지. 이들은 절대 컴퓨터를 떠나지 않습니다.",
    "PDF、DOCX、TXT、MDまたはウェブページ。これらは決してあなたのマシンを離れません。",
    "PDF، DOCX، TXT، MD أو صفحات ويب. إنها لا تغادر جهازك مطلقًا.",
    "PDF, DOCX, TXT, MD o pagine web. Non lasciano mai il tuo computer."
  ],
  [
    "pending",
    "待处理",
    "대기 중",
    "保留中",
    "قيد الانتظار",
    "in sospeso"
  ],
  [
    "Permanently delete",
    "永久删除",
    "영구 삭제",
    "永久に削除",
    "حذف نهائي",
    "Elimina permanentemente"
  ],
  [
    "Perplexity",
    "困惑度",
    "혼란도",
    "Perplexity",
    "الحيرة",
    "Perplessità"
  ],
  [
    "PERPLEXITY",
    "困惑",
    "당혹",
    "困惑",
    "الحيرة",
    "PERPLESSITÀ"
  ],
  [
    "Persist model + colour + prompt into the team template",
    "将模型 + 颜色 + 提示保存到团队模板中",
    "팀 템플릿에 모델 + 색상 + 프롬프트 저장",
    "モデル + 色 + プロンプトをチームのテンプレートに保存する",
    "احفظ النموذج + اللون + المطالبة في قالب الفريق",
    "Persisti modello + colore + prompt nel modello del team"
  ],
  [
    "Persist these settings to ~/.owllm/bridge_config.json",
    "将这些设置保存到 ~/.owllm/bridge_config.json",
    "이 설정을 ~/.owllm/bridge_config.json에 저장하십시오",
    "これらの設定を ~/.owllm/bridge_config.json に保存する",
    "احفظ هذه الإعدادات في ~/.owllm/bridge_config.json",
    "Persisti queste impostazioni in ~/.owllm/bridge_config.json"
  ],
  [
    "Persist to ~/.owllm/bridge_config.json",
    "保存到 ~/.owllm/bridge_config.json",
    "~/.owllm/bridge_config.json에 저장",
    "~/.owllm/bridge_config.json に保存する",
    "احفظ في ~/.owllm/bridge_config.json",
    "Persisti in ~/.owllm/bridge_config.json"
  ],
  [
    "Persistent knowledge-graph store. Agents can save+recall facts across sessions.",
    "持久化知识图存储。智能体可以跨会话保存和检索事实。",
    "지속적인 지식 그래프 저장소. 에이전트는 세션 간에 사실을 저장하고 불러올 수 있습니다.",
    "永続的なナレッジグラフストア。エージェントはセッションを超えて事実を保存および呼び出すことができます。",
    "مخزن قاعدة المعرفة المستمر. يمكن للوكلاء حفظ واسترجاع الحقائق عبر الجلسات.",
    "Archivio persistente del grafo della conoscenza. Gli agenti possono salvare e richiamare fatti tra le sessioni."
  ],
  [
    "Personal access token. Classic or fine-grained both work. Grant the scopes you want the agent to use (repo, read:org, etc).",
    "个人访问令牌。经典或精细控制的都可以。授予您希望智能体使用的权限（仓库、读取：组织等）。",
    "개인 액세스 토큰. 클래식 또는 세분화된 토큰 모두 사용 가능. 에이전트가 사용할 권한을 부여하세요 (repo, read:org 등).",
    "パーソナルアクセストークン。クラシックでもファイングレインでも両方機能します。エージェントに使用させたいスコープを付与してください（repo、read:org など）。",
    "رمز الوصول الشخصي. الكلاسيكي أو المفصل كلاهما يعمل. امنح الصلاحيات التي تريد أن يستخدمها الوكيل (المستودع، قراءة: المؤسسات، إلخ).",
    "Token di accesso personale. Sia classico che a livello granulare funzionano. Concedi i permessi che vuoi che l'agente usi (repo, read:org, ecc)."
  ],
  [
    "Personal assistant",
    "个人助手",
    "개인 비서",
    "パーソナルアシスタント",
    "مساعد شخصي",
    "Assistente Personale"
  ],
  [
    "Personal Assistant",
    "个人助理",
    "개인 비서",
    "パーソナルアシスタント",
    "مساعد شخصي",
    "Assistente personale"
  ],
  [
    "Phi",
    "Phi",
    "Phi",
    "ファイ",
    "في",
    "Phi"
  ],
  [
    "Pick",
    "选择",
    "선택",
    "選ぶ",
    "اختر",
    "Scegli"
  ],
  [
    "Pick a base model in the Base Model card above first.",
    "首先在上方的基础模型卡片中选择一个基础模型。",
    "먼저 위의 기본 모델 카드에서 기본 모델을 선택하세요.",
    "まず上のベースモデルカードでベースモデルを選んでください。",
    "اختر نموذجًا أساسيًا في بطاقة النموذج الأساسي أعلاه أولاً.",
    "Scegli prima un modello base nella scheda Modello Base sopra."
  ],
  [
    "Pick a different folder to use as the workspace root.",
    "选择一个不同的文件夹作为工作区根目录。",
    "작업 공간 루트로 사용할 다른 폴더를 선택하세요.",
    "作業スペースのルートとして使用する別のフォルダーを選択してください。",
    "اختر مجلدًا مختلفًا لاستخدامه كجذر مساحة العمل.",
    "Scegli una cartella diversa da usare come radice dello spazio di lavoro."
  ],
  [
    "Pick a folder on your drive…",
    "在你的驱动器上选择一个文件夹…",
    "드라이브에서 폴더를 선택하세요…",
    "ドライブ上のフォルダーを選択してください…",
    "اختر مجلداً على محرك الأقراص الخاص بك…",
    "Scegli una cartella sul tuo drive…"
  ],
  [
    "Pick a folder, choose a model, and describe the change.",
    "选择一个文件夹，选择一个模型，并描述更改。",
    "폴더를 선택하고, 모델을 선택한 다음 변경 사항을 설명하세요.",
    "フォルダーを選択し、モデルを選択して、変更内容を説明してください。",
    "اختر مجلدًا، واختر نموذجًا، وصف التغيير.",
    "Scegli una cartella, seleziona un modello e descrivi la modifica."
  ],
  [
    "Pick a model above first.",
    "请先选择上方的模型。",
    "먼저 위에서 모델을 선택하세요.",
    "まず上のモデルを選択してください。",
    "اختر نموذجًا أعلاه أولاً.",
    "Scegli prima un modello sopra."
  ],
  [
    "Pick a model above to start a server.",
    "选择上方的模型以启动服务器。",
    "서버를 시작하려면 위에서 모델을 선택하세요.",
    "サーバーを起動するには、上のモデルを選択してください。",
    "اختر نموذجًا أعلاه لبدء الخادم.",
    "Scegli un modello sopra per avviare un server."
  ],
  [
    "Pick a model to generate the pairs.",
    "选择一个模型来生成配对。",
    "쌍을 생성하려면 모델을 선택하세요.",
    "ペアを生成するには、モデルを選択してください。",
    "اختر نموذجًا لتوليد الأزواج.",
    "Scegli un modello per generare le coppie."
  ],
  [
    "Pick a model, get guided walkthroughs, or screenshot your screen and ask.",
    "选择一个模型，获取引导式演练，或截图你的屏幕并提问。",
    "모델을 선택하고 안내된 워크스루를 받거나 화면을 캡처하고 질문하세요.",
    "モデルを選択するか、ガイド付きウォークスルーを利用するか、画面をスクリーンショットして質問してください。",
    "اختر نموذجًا، واحصل على جولات إرشادية، أو التقط لقطة شاشة لشاشتك واسأل.",
    "Scegli un modello, segui le guide passo passo o fai uno screenshot del tuo schermo e chiedi."
  ],
  [
    "Pick a project first",
    "请先选择一个项目。",
    "먼저 프로젝트를 선택하세요.",
    "まずプロジェクトを選択してください。",
    "اختر مشروعًا أولاً",
    "Scegli prima un progetto"
  ],
  [
    "Pick a project folder",
    "选择一个项目文件夹。",
    "프로젝트 폴더를 선택하세요.",
    "プロジェクトフォルダーを選択してください。",
    "اختر مجلد مشروع",
    "Scegli una cartella del progetto"
  ],
  [
    "Pick a project on the strip up top, or click",
    "在顶部条上选择一个项目，或点击",
    "위 상단의 스트립에서 프로젝트를 선택하거나 클릭하세요.",
    "上部のストリップでプロジェクトを選択するか、クリックしてください。",
    "اختر مشروعًا على الشريط العلوي، أو انقر",
    "Scegli un progetto sulla striscia in alto, oppure clicca"
  ],
  [
    "Pick a project on the strip up top, or load a team template.",
    "在顶部条上选择一个项目，或加载团队模板。",
    "위 상단의 스트립에서 프로젝트를 선택하거나 팀 템플릿을 불러오세요.",
    "上部のストリップでプロジェクトを選択するか、チームテンプレートを読み込んでください。",
    "اختر مشروعًا على الشريط العلوي، أو قم بتحميل قالب فريق.",
    "Scegli un progetto sulla striscia in alto, oppure carica un modello di team."
  ],
  [
    "Pick a project on the strip, or click",
    "在条带上选择一个项目，或点击",
    "스트립에서 프로젝트를 선택하거나 클릭하세요.",
    "ストリップでプロジェクトを選択するか、クリックしてください。",
    "اختر مشروعًا على الشريط، أو انقر",
    "Scegli un progetto sulla striscia, o clicca"
  ],
  [
    "Pick a project or team template to begin.",
    "选择一个项目或团队模板以开始。",
    "시작하려면 프로젝트 또는 팀 템플릿을 선택하세요.",
    "プロジェクトまたはチームのテンプレートを選んで始めてください。",
    "اختر مشروعًا أو قالب فريق للبدء.",
    "Scegli un progetto o un modello di team per iniziare."
  ],
  [
    "Pick a quantization, then click Export.",
    "选择一个量化，然后点击导出。",
    "양자화를 선택한 다음 내보내기를 클릭하세요.",
    "量子化を選択してから、エクスポートをクリックしてください。",
    "اختر التكميم، ثم انقر تصدير.",
    "Scegli una quantizzazione, poi clicca Esporta."
  ],
  [
    "Pick a source or paste a custom git URL first.",
    "首先选择一个源或粘贴自定义 git URL。",
    "먼저 소스를 선택하거나 커스텀 git URL을 붙여넣으세요.",
    "まずソースを選択するか、カスタム git URL を貼り付けてください。",
    "اختر مصدرًا أو الصق عنوان URL مخصص لمستودع git أولاً.",
    "Scegli prima una sorgente o incolla un URL git personalizzato."
  ],
  [
    "Pick a team from the grid to see the agents it ships with,",
    "从网格中选择一个团队以查看它附带的代理，",
    "그리드에서 팀을 선택하여 포함된 에이전트를 보세요.",
    "グリッドからチームを選んで、それに付属するエージェントを確認してください。",
    "اختر فريقًا من الشبكة لرؤية الوكلاء المضمنين معه.",
    "Scegli un team dalla griglia per vedere gli agenti con cui viene fornito,"
  ],
  [
    "Pick a training dataset",
    "选择一个训练数据集",
    "학습 데이터셋을 선택하세요.",
    "トレーニングデータセットを選んでください。",
    "اختر مجموعة بيانات للتدريب.",
    "Scegli un dataset di addestramento"
  ],
  [
    "Pick a training dataset first (Dataset card above).",
    "首先选择一个训练数据集（上方的数据集卡片）。",
    "먼저 학습 데이터셋을 선택하세요 (위의 데이터셋 카드).",
    "まずトレーニングデータセットを選んでください（上のデータセットカード）。",
    "اختر مجموعة بيانات للتدريب أولاً (بطاقة مجموعة البيانات أعلاه).",
    "Scegli prima un dataset di addestramento (Carta del dataset sopra)."
  ],
  [
    "Pick a voice",
    "选择一个语音",
    "음성을 선택하세요.",
    "音声を選んでください。",
    "اختر صوتًا.",
    "Scegli una voce"
  ],
  [
    "Pick a workflow: Code Operator, Product Studio, Research Lab, Chief of Staff, n8n Workflow Builder, Data Room, or Content Studio. MCP packs configure the tools those workflows need.",
    "选择一个工作流程：代码操作员、产品工作室、研究实验室、参谋长、n8n 工作流构建器、数据室或内容工作室。MCP 套装配置这些工作流程所需的工具。",
    "워크플로를 선택하세요: 코드 오퍼레이터, 제품 스튜디오, 리서치 랩, 비서실장, n8n 워크플로 빌더, 데이터 룸, 또는 콘텐츠 스튜디오. MCP 팩은 해당 워크플로가 필요로 하는 도구를 구성합니다.",
    "ワークフローを選んでください：コードオペレーター、プロダクトスタジオ、リサーチラボ、チーフオブスタッフ、n8nワークフロービルダー、データルーム、またはコンテンツスタジオ。MCPパックは、それらのワークフローに必要なツールを設定します。",
    "اختر سير العمل: مشغل الكود، استوديو المنتجات، مختبر البحث، رئيس الموظفين، منشئ سير العمل n8n، غرفة البيانات، أو استوديو المحتوى. تقوم حزم MCP بتكوين الأدوات التي تحتاجها هذه سير العمل.",
    "Scegli un flusso di lavoro: Code Operator, Product Studio, Research Lab, Chief of Staff, n8n Workflow Builder, Data Room o Content Studio. I pacchetti MCP configurano gli strumenti di cui quei flussi di lavoro hanno bisogno."
  ],
  [
    "Pick a workspace folder first (Browse).",
    "首先选择一个工作区文件夹（浏览）。",
    "먼저 작업 공간 폴더를 선택하세요 (찾아보기).",
    "まずワークスペースフォルダを選んでください（参照）。",
    "اختر مجلد مساحة العمل أولاً (تصفح).",
    "Scegli prima una cartella di lavoro (Sfoglia)."
  ],
  [
    "Pick a workspace folder first…",
    "请先选择一个工作区文件夹…",
    "먼저 작업 공간 폴더를 선택하세요…",
    "まずワークスペースフォルダを選んでください…",
    "اختر مجلد مساحة العمل أولاً…",
    "Seleziona prima una cartella di lavoro…"
  ],
  [
    "Pick agents, name it, save it as a template.",
    "选择代理，命名，然后保存为模板。",
    "에이전트를 선택하고 이름을 지정한 후 템플릿으로 저장하세요.",
    "エージェントを選び、名前を付け、それをテンプレートとして保存します。",
    "اختر الوكلاء، سمّه، واحفظه كقالب.",
    "Scegli agenti, chiamalo, salvalo come modello."
  ],
  [
    "Pick an icon for",
    "选择一个图标为",
    "아이콘을 선택하세요.",
    "アイコンを選択する",
    "اختر أيقونة لـ",
    "Scegli un'icona per"
  ],
  [
    "Pick at least one file, or check 'Download all'.",
    "至少选择一个文件，或者勾选“下载全部”。",
    "최소한 하나의 파일을 선택하거나 '모두 다운로드'를 체크하세요.",
    "少なくとも1つのファイルを選択するか、「すべてダウンロード」にチェックしてください。",
    "اختر ملفًا واحدًا على الأقل، أو ضع علامة على 'تحميل الكل'.",
    "Seleziona almeno un file, oppure spunta 'Scarica tutto'."
  ],
  [
    "Pick or type a folder first",
    "先选择或输入一个文件夹",
    "먼저 폴더를 선택하거나 입력하세요.",
    "最初にフォルダを選択するか入力してください。",
    "اختر أو اكتب مجلدًا أولاً",
    "Seleziona o digita prima una cartella"
  ],
  [
    "Pick the card / node colour",
    "选择卡片/节点颜色",
    "카드 / 노드 색상을 선택하세요.",
    "カード／ノードの色を選択する",
    "اختر لون البطاقة / العقدة",
    "Scegli il colore della scheda/nodo"
  ],
  [
    "Pick which downloaded model the inference server should serve.",
    "选择推理服务器应使用的已下载模型。",
    "어떤 다운로드한 모델을 추론 서버가 서비스할지 선택하세요.",
    "推論サーバーが提供するダウンロード済みモデルを選択してください。",
    "اختر النموذج الذي تم تنزيله والذي يجب على خادم الاستنتاج تقديمه.",
    "Scegli quale modello scaricato il server di inferenza dovrebbe servire."
  ],
  [
    "Pin to top",
    "置顶",
    "상단에 고정",
    "上部に固定",
    "تثبيت في الأعلى",
    "Fissa in alto"
  ],
  [
    "Ping the running MCP server's /health endpoint and show whether it's responsive.",
    "Ping 正在运行的 MCP 服务器的 /health 端点，并显示其是否响应。",
    "실행 중인 MCP 서버의 /health 엔드포인트를 호출하고 응답 여부를 표시합니다.",
    "実行中のMCPサーバーの /health エンドポイントに ping を送り、応答があるかどうかを表示します。",
    "اختبر نقطة النهاية /health الخاصة بخادم MCP الجاري وعرض ما إذا كان يستجيب.",
    "Invia un ping all'endpoint /health del server MCP in esecuzione e mostra se risponde."
  ],
  [
    "Pipeline: {0}",
    "管道：{0}",
    "파이프라인: {0}",
    "パイプライン: {0}",
    "خط المعالجة: {0}",
    "Pipeline: {0}"
  ],
  [
    "plan",
    "计划",
    "계획",
    "計画",
    "خطة",
    "piano"
  ],
  [
    "Plan board",
    "计划板",
    "계획 보드",
    "プランボード",
    "لوحة التخطيط",
    "Bacheca del piano"
  ],
  [
    "Plan complete.",
    "计划完成。",
    "계획 완료.",
    "計画完了。",
    "اكتملت الخطة.",
    "Piano completato."
  ],
  [
    "planning",
    "规划中",
    "계획 중",
    "計画中",
    "تخطيط",
    "pianificazione"
  ],
  [
    "Planning…",
    "计划中…",
    "계획 중…",
    "計画中…",
    "التخطيط…",
    "Pianificazione…"
  ],
  [
    "Plans the work and dispatches the specialists.",
    "规划工作并调度专家。",
    "작업을 계획하고 전문가를 배치합니다.",
    "作業を計画し、専門家を派遣します。 ",
    "يخطط العمل ويرسل المتخصصين.",
    "Pianifica il lavoro e invia gli specialisti."
  ],
  [
    "Play",
    "播放",
    "실행",
    "再生 ",
    "تشغيل",
    "Riproduci"
  ],
  [
    "Play a scripted demo using the SAME event stream a real run emits",
    "使用真实运行发出的相同事件流播放脚本演示",
    "실제 실행이 내보내는 동일한 이벤트 스트림을 사용하여 스크립트된 데모를 실행합니다",
    "実際の実行が出力するのと同じイベントストリームを使用してスクリプト化されたデモを再生する ",
    "تشغيل عرض توضيحي مكتوب باستخدام نفس تدفق الأحداث الذي تصدره عملية حقيقية",
    "Esegui una demo scriptata utilizzando lo STESSO flusso di eventi che una sessione reale emette"
  ],
  [
    "port",
    "端口",
    "포트",
    "ポート ",
    "منفذ",
    "porta"
  ],
  [
    "port (auto)",
    "端口（自动）",
    "포트 (자동)",
    "ポート（自動） ",
    "منفذ (تلقائي)",
    "porta (auto)"
  ],
  [
    "Port:",
    "端口：",
    "포트:",
    "ポート: ",
    "المنفذ:",
    "Porta:"
  ],
  [
    "Posted",
    "发布",
    "게시됨",
    "投稿済み ",
    "تم النشر",
    "Pubblicato"
  ],
  [
    "PREFER",
    "优先",
    "선호",
    "優先 ",
    "يفضل",
    "PREFERISCI"
  ],
  [
    "Prefer to paste a token?",
    "想要粘贴令牌吗？",
    "토큰을 붙여넣기 하시겠습니까?",
    "トークンを貼り付けたいですか？ ",
    "هل تفضل لصق رمز؟",
    "Preferisci incollare un token?"
  ],
  [
    "preferred, falling back to Brave Search when a key is saved. Use this",
    "优先使用，保存键后备用 Brave 搜索。使用此",
    "선호됨, 키가 저장되어 있을 때 Brave Search로 대체됩니다. 이것을 사용하세요",
    "キーが保存されている場合、Brave Searchにフォールバックすることを優先します。これを使用 ",
    "مفضل، العودة إلى Brave Search عند حفظ مفتاح. استخدم هذا",
    "preferito, con fallback su Brave Search quando una chiave è salvata. Usa questo"
  ],
  [
    "preparing",
    "正在准备",
    "준비 중",
    "準備中 ",
    "جارٍ التحضير",
    "preparando"
  ],
  [
    "Preparing (memory · sandbox · model)…",
    "准备中（内存·沙箱·模型)…",
    "준비 중 (메모리 · 샌드박스 · 모델)…",
    "準備中（メモリ · サンドボックス · モデル）… ",
    "التحضير (الذاكرة · الحديقة الرملية · النموذج)…",
    "Preparazione (memoria · sandbox · modello)…"
  ],
  [
    "Preparing a private workspace for",
    "为...准备私人工作区",
    "개인 작업 공간 준비 중",
    "のためにプライベートワークスペースを準備中 ",
    "تحضير مساحة عمل خاصة لـ",
    "Preparando uno spazio di lavoro privato per"
  ],
  [
    "Preparing next item...",
    "正在准备下一个项目...",
    "다음 항목 준비 중...",
    "次のアイテムを準備中... ",
    "تحضير العنصر التالي...",
    "Preparando il prossimo elemento..."
  ],
  [
    "Preparing the workspace — unlocks in a moment",
    "准备工作区——片刻后解锁",
    "작업 공간 준비 중 — 잠시 후에 잠금 해제됩니다  ",
    "ワークスペースを準備中 — まもなく解除",
    "تحضير مساحة العمل — سيتم الفتح بعد لحظة",
    "Preparare lo spazio di lavoro — sblocchi tra un momento"
  ],
  [
    "Press a keyboard key in the persistent browser (e.g. 'Enter', 'Tab', 'Escape',",
    "在持久浏览器中按下键盘键（例如 'Enter'、'Tab'、'Escape'）",
    "지속적인 브라우저에서 키보드 키를 누르세요(예: 'Enter', 'Tab', 'Escape')",
    "永続的なブラウザでキーボードキーを押してください（例：'Enter'、'Tab'、'Escape'）",
    "اضغط على مفتاح من لوحة المفاتيح في المتصفح المستمر (مثل 'Enter'، 'Tab'، 'Escape',",
    "Premi un tasto sulla tastiera nel browser persistente (es. 'Invio', 'Tab', 'Esc',"
  ],
  [
    "Press Rescan to detect browsers.",
    "按“重新扫描”以检测浏览器。",
    "브라우저를 감지하려면 다시 스캔을 누르세요.",
    "再スキャンを押してブラウザを検出します。",
    "اضغط على إعادة المسح لاكتشاف المتصفحات.",
    "Premi Riscansiona per rilevare i browser."
  ],
  [
    "Press Stop to abort.",
    "按“停止”以中止。",
    "중단하려면 정지를 누르세요.",
    "停止を押して中止します。",
    "اضغط على إيقاف للإلغاء.",
    "Premi Stop per annullare."
  ],
  [
    "Prevent the decorative window frame from fading while you work",
    "在工作时防止装饰窗框褪色",
    "작업 중 장식 창 테두리가 희미해지지 않도록 방지",
    "作業中に装飾ウィンドウフレームがフェードしないようにします",
    "منع إطار النافذة الزخرفي من التلاشي أثناء العمل",
    "Previeni lo sbiadimento della cornice decorativa della finestra mentre lavori"
  ],
  [
    "Preview this voice",
    "预览此语音",
    "이 음성을 미리보기",
    "この音声をプレビュー",
    "معاينة هذا الصوت",
    "Anteprima di questa voce"
  ],
  [
    "probing hardware…",
    "探测硬件…",
    "하드웨어를 점검 중…  ",
    "ハードウェアをプローブ中…",
    "فحص الأجهزة...",
    "verifica dell'hardware..."
  ],
  [
    "Probing…",
    "探测中…",
    "점검 중…  ",
    "プローブ中…",
    "جارٍ الفحص...",
    "Verifica in corso..."
  ],
  [
    "Project",
    "项目",
    "프로젝트",
    "プロジェクト",
    "المشروع",
    "Progetto"
  ],
  [
    "Project — agents from the saved roster.",
    "项目——来自已保存名册的代理。",
    "프로젝트 — 저장된 명단의 에이전트들.",
    "プロジェクト — 保存された名簿からのエージェント。",
    "المشروع — وكلاء من القائمة المحفوظة.",
    "Progetto — agenti dal registro salvato."
  ],
  [
    "Project Brainstorm",
    "项目头脑风暴",
    "프로젝트 브레인스토밍",
    "プロジェクトブレインストーム",
    "عصف ذهني للمشروع",
    "Brainstorming del progetto"
  ],
  [
    "Project folder",
    "项目文件夹",
    "프로젝트 폴더",
    "プロジェクトフォルダ",
    "مجلد المشروع",
    "Cartella del progetto"
  ],
  [
    "Project name",
    "项目名称",
    "프로젝트 이름",
    "プロジェクト名",
    "اسم المشروع",
    "Nome del progetto"
  ],
  [
    "Project rules",
    "项目规则",
    "프로젝트 규칙",
    "プロジェクトルール",
    "قواعد المشروع",
    "Regole del progetto"
  ],
  [
    "Project settings — folder, security, team, bridge, rename, delete",
    "项目设置 — 文件夹、安全、团队、桥接、重命名、删除",
    "프로젝트 설정 — 폴더, 보안, 팀, 브리지, 이름 변경, 삭제",
    "プロジェクト設定 — フォルダ、セキュリティ、チーム、ブリッジ、名前変更、削除",
    "إعدادات المشروع — المجلد، الأمان، الفريق، الجسر، إعادة التسمية، الحذف",
    "Impostazioni del progetto — cartella, sicurezza, team, bridge, rinomina, elimina"
  ],
  [
    "Promote to a durable fact (kept forever, synced across your PCs)",
    "提升为持久事实（永久保存，同步到你的电脑）",
    "영속적인 사실로 승격 (영구 보관, PC 간 동기화)",
    "耐久性のある事実として昇格（永久に保持され、PC間で同期されます）",
    "ترقية إلى حقيقة دائمة (تُحفظ للأبد، متزامنة عبر أجهزة الكمبيوتر الخاصة بك)",
    "Promuovi a un fatto duraturo (conservato per sempre, sincronizzato tra i tuoi PC)"
  ],
  [
    "prompt",
    "提示",
    "프롬프트",
    "プロンプト",
    "مطالبة",
    "prompt"
  ],
  [
    "Prompt (augments this agent's role)",
    "提示（增强此代理的角色）",
    "프롬프트 (이 에이전트의 역할을 보강)",
    "プロンプト（このエージェントの役割を拡張）",
    "المطالبة (تعزز دور هذا الوكيل)",
    "Prompt (incrementa il ruolo di questo agente)"
  ],
  [
    "Proposed plan",
    "拟议计划",
    "제안된 계획",
    "提案された計画",
    "الخطة المقترحة",
    "Piano proposto"
  ],
  [
    "Proposed steps",
    "拟议步骤",
    "제안된 단계",
    "提案された手順",
    "الخطوات المقترحة",
    "Passaggi proposti"
  ],
  [
    "Proposed team — review, then apply. You can change each agent's model on the canvas before running.",
    "拟议团队 — 审核，然后应用。您可以在运行之前更改画布上每个代理的模型。",
    "제안된 팀 — 검토 후 적용. 실행하기 전에 캔버스에서 각 에이전트의 모델을 변경할 수 있습니다.",
    "提案チーム — レビュー後に適用。実行前にキャンバス上で各エージェントのモデルを変更できます。",
    "الفريق المقترح — راجع، ثم طبق. يمكنك تغيير نموذج كل وكيل على اللوحة قبل التشغيل.",
    "Team proposto — rivedi, poi applica. Puoi cambiare il modello di ciascun agente sulla tela prima di eseguire."
  ],
  [
    "Proposed update",
    "拟议更新",
    "제안된 업데이트",
    "提案された更新",
    "التحديث المقترح",
    "Aggiornamento proposto"
  ],
  [
    "Protected · inspect only",
    "受保护 · 仅检查",
    "보호됨 · 보기 전용",
    "保護済み · 閲覧のみ",
    "محمي · للعرض فقط",
    "Protetto · solo ispezione"
  ],
  [
    "Public endpoint",
    "公共端点",
    "공개 엔드포인트",
    "公開エンドポイント",
    "نقطة نهاية عامة",
    "Endpoint pubblico"
  ],
  [
    "Publish",
    "发布",
    "게시",
    "公開",
    "نشر",
    "Pubblica"
  ],
  [
    "Publish a new release? ({0})",
    "发布新版本？（{0}）",
    "새 릴리스를 게시하시겠습니까? ({0})",
    "新しいリリースを公開しますか？（{0}）",
    "نشر إصدار جديد؟ ({0})",
    "Pubblicare una nuova versione? ({0})"
  ],
  [
    "Publish command",
    "发布命令",
    "게시 명령",
    "公開コマンド",
    "أمر النشر",
    "Comando di pubblicazione"
  ],
  [
    "Publish mode",
    "发布模式",
    "게시 모드",
    "公開モード",
    "وضع النشر",
    "Modalità di pubblicazione"
  ],
  [
    "Publish public release",
    "发布公共版本",
    "공개 릴리스 게시",
    "公衆向けリリースを公開",
    "نشر الإصدار العام",
    "Pubblica versione pubblica"
  ],
  [
    "Publish script",
    "发布脚本",
    "게시 스크립트",
    "公開スクリプト",
    "نشر البرنامج النصي",
    "Pubblica script"
  ],
  [
    "Publish settings",
    "发布设置",
    "게시 설정",
    "公開設定",
    "إعدادات النشر",
    "Impostazioni di pubblicazione"
  ],
  [
    "publish-release.sh: build → minisign → latest.json → gh release → verify).",
    "publish-release.sh：构建 → minisign → latest.json → GitHub 发布 → 验证)。",
    "publish-release.sh: 빌드 → minisign → latest.json → gh 릴리스 → 검증).",
    "publish-release.sh: ビルド → minisign → latest.json → gh release → 検証",
    "publish-release.sh: البناء → minisign → latest.json → إصدار GitHub → التحقق).",
    "publish-release.sh: build → minisign → latest.json → gh release → verify)."
  ],
  [
    "Published by {0}",
    "由 {0} 发布",
    "{0}에 의해 게시됨",
    "{0}によって公開されました",
    "نشر بواسطة {0}",
    "Pubblicato da {0}"
  ],
  [
    "Pull device records from the GitHub vault",
    "从 GitHub 金库拉取设备记录",
    "GitHub 금고에서 장치 기록 가져오기",
    "GitHubボールトからデバイス記録を取得",
    "سحب سجلات الأجهزة من خزنة GitHub",
    "Recupera i record dei dispositivi dal vault di GitHub"
  ],
  [
    "Push",
    "推送",
    "푸시",
    "プッシュ",
    "ادفع",
    "Push"
  ],
  [
    "Push {0} commit(s) on {1} to origin",
    "将 {0} 个提交在 {1} 上推送到 origin",
    "{1}에서 {0} 커밋을 원본에 푸시",
    "{1}の{0}件のコミットをoriginにプッシュ",
    "ادفع {0} التزام(ات) على {1} إلى الأصل",
    "Push {0} commit(s) su {1} su origin"
  ],
  [
    "Push {0} to origin",
    "将 {0} 推送到 origin",
    "{0}을 원본에 푸시",
    "{0}をoriginにプッシュ",
    "ادفع {0} إلى الأصل",
    "Push {0} su origin"
  ],
  [
    "Push to GitHub secrets",
    "推送到 GitHub 秘密",
    "GitHub 시크릿에 푸시",
    "GitHubシークレットにプッシュ",
    "ادفع إلى أسرار GitHub",
    "Push ai segreti di GitHub"
  ],
  [
    "Q2_K",
    "Q2_K",
    "Q2_K",
    "Q2_K",
    "Q2_K",
    "Q2_K"
  ],
  [
    "Q3_K_M",
    "Q3_K_M",
    "Q3_K_M",
    "Q3_K_M",
    "Q3_K_M",
    "Q3_K_M"
  ],
  [
    "Q4_K_M",
    "Q4_K_M",
    "Q4_K_M",
    "Q4_K_M",
    "Q4_K_M",
    "Q4_K_M"
  ],
  [
    "Q4_K_S",
    "Q4_K_S",
    "Q4_K_S",
    "Q4_K_S",
    "Q4_K_S",
    "Q4_K_S"
  ],
  [
    "Q5_K_M",
    "Q5_K_M",
    "Q5_K_M",
    "Q5_K_M",
    "Q5_K_M",
    "Q5_K_M"
  ],
  [
    "Q6_K",
    "Q6_K",
    "Q6_K",
    "Q6_K",
    "Q6_K",
    "Q6_K"
  ],
  [
    "Q8_0",
    "Q8_0",
    "Q8_0",
    "Q8_0",
    "Q8_0",
    "Q8_0"
  ],
  [
    "Qt source:",
    "Qt 源代码：",
    "Qt 소스:",
    "Qtソース:",
    "مصدر Qt:",
    "Sorgente Qt:"
  ],
  [
    "Quest Plaza",
    "任务广场",
    "퀘스트 광장",
    "クエストプラザ",
    "ساحة المهمة",
    "Quest Plaza"
  ],
  [
    "Quests",
    "任务",
    "퀘스트",
    "クエスト",
    "المهمات",
    "Missioni"
  ],
  [
    "Queue another message…",
    "排队另一条消息…",
    "메시지를 대기열에 추가…",
    "またメッセージを送る...",
    "انتظر رسالة أخرى…",
    "Metti in coda un altro messaggio…"
  ],
  [
    "queued",
    "已排队",
    "대기 중",
    "キューに入った",
    "في الطابور",
    "in coda"
  ],
  [
    "queued — steers the live run",
    "已排队 — 引导实时运行",
    "대기열 — 라이브 실행을 조정함",
    "キューに並ぶ — ライブランを操縦する",
    "مُدرَج — يوجه العملية الحية",
    "in coda — guida l'esecuzione dal vivo"
  ],
  [
    "Quick add — popular MCP servers",
    "快速添加 — 流行的 MCP 服务器",
    "빠른 추가 — 인기 있는 MCP 서버",
    "クイック追加 — 人気のMCPサーバー",
    "إضافة سريعة — خوادم MCP الشهيرة",
    "Aggiunta rapida — server MCP popolari"
  ],
  [
    "Qwen 3 (thinking)",
    "Qwen 3（思考）",
    "Qwen 3 (생각 중)",
    "Qwen 3(考える中)",
    "كوان 3 (يفكر)",
    "Qwen 3 (pensando)"
  ],
  [
    "Raw model output will appear here.",
    "原始模型输出将显示在这里。",
    "원시 모델 출력이 여기에 표시됩니다.",
    "生モデルの出力はここに掲載されます。",
    "سيظهر مخرجات النموذج الخام هنا.",
    "L'output grezzo del modello apparirà qui."
  ],
  [
    "Re-add the built-in best-practice rules you've deleted (won't duplicate ones you kept)",
    "重新添加你删除的内置最佳实践规则（不会重复保留的那些）",
    "삭제한 내장 모범 사례 규칙을 다시 추가하세요(보관한 규칙은 중복되지 않음)",
    "削除した組み込みのベストプラクティスルールを再追加してください(残したルールは重複しません)",
    "أعد إضافة قواعد أفضل الممارسات المدمجة التي قمت بحذفها (لن يتم تكرار تلك التي احتفظت بها)",
    "Reinserisci le regole migliori integrate che hai cancellato (non duplicherà quelle che hai mantenuto)"
  ],
  [
    "Re-check",
    "重新检查",
    "다시 확인",
    "再確認",
    "إعادة التحقق",
    "Ricontrolla"
  ],
  [
    "Re-check WSL / GPU / environment / runtime",
    "重新检查 WSL / GPU / 环境 / 运行时",
    "WSL / GPU / 환경 / 런타임 다시 확인",
    "WSL / GPU / 環境 / ランタイムを再確認してください",
    "إعادة التحقق من WSL / GPU / البيئة / وقت التشغيل",
    "Ricontrolla WSL / GPU / ambiente / runtime"
  ],
  [
    "Re-derive this team's agents + wiring from the built-in {0} template (picks up renamed/repurposed agents). Keeps your per-agent model picks.",
    "从内置的 {0} 模板重新推导本团队的代理和连接（会拾取重命名/重新用途的代理）。保持你每个代理的模型选择。",
    "이 팀의 에이전트 + 배선을 내장 {0} 템플릿에서 다시 도출(이름이 바뀌거나 재사용된 에이전트 포함). 에이전트별 모델 선택은 유지됨",
    "このチームのエージェント+配線を組み込みの{0}テンプレートから再派生します(名前変更・再利用されたエージェントをピックアップします)。エージェントごとのモデル選択を保持できます。",
    "إعادة اشتقاق وكلاء هذا الفريق + التوصيلات من قالب {0} المدمج (يلتقط الوكلاء الذين تم إعادة تسميتهم / إعادة تخصيصهم). يحتفظ باختيارات النموذج الخاصة بكل وكيل.",
    "Rideriva gli agenti di questo team + il cablaggio dal modello integrato {0} (include agenti rinominati/riutilizzati). Mantiene le tue scelte di modello per agente."
  ],
  [
    "Re-open this step",
    "重新打开此步骤",
    "이 단계 다시 열기",
    "このステップを再度開く",
    "إعادة فتح هذه الخطوة",
    "Riapri questo passaggio"
  ],
  [
    "Re-run brainstorm (BRIEF.md exists — will be overwritten)",
    "重新运行头脑风暴（BRIEF.md 已存在 — 将被覆盖）",
    "브레인스토밍 재실행 (BRIEF.md가 존재함 — 덮어쓰기 됨)",
    "ブレインストームを再実行（BRIEF.md が存在 — 上書きされます）",
    "إعادة تشغيل جلسة العصف الذهني (ملف BRIEF.md موجود — سيتم الكتابة فوقه)",
    "Esegui di nuovo il brainstorming (BRIEF.md esiste — sarà sovrascritto)"
  ],
  [
    "Re-scan for live inference servers.",
    "重新扫描实时推理服务器。",
    "라이브 추론 서버 다시 스캔",
    "ライブ推論サーバーを再スキャン。",
    "إعادة المسح عن خوادم الاستدلال الحية.",
    "Riscansiona per i server di inferenza live."
  ],
  [
    "Read",
    "读取",
    "읽기",
    "読む",
    "قراءة",
    "Leggi"
  ],
  [
    "Read a UTF-8 text file from disk. Returns the contents as a string.",
    "从磁盘读取 UTF-8 文本文件。以字符串形式返回内容。",
    "디스크에서 UTF-8 텍스트 파일 읽기. 내용을 문자열로 반환",
    "ディスクからUTF-8テキストファイルを読み込みます。内容を文字列として返します。",
    "اقرأ ملف نصي بتشفير UTF-8 من القرص. يُرجع المحتويات كسلسلة.",
    "Leggi un file di testo UTF-8 dal disco. Restituisce il contenuto come stringa."
  ],
  [
    "Read ONE shared-memory entry by its exact key (the precise complement to",
    "通过其精确键读取一个共享内存条目（与……精确互补）",
    "정확한 키로 하나의 공유 메모리 항목 읽기 (정확한 보완)",
    "正確なキーによって、共有メモリエントリを1つ読み取ります（まさにその補完です）",
    "اقرأ إدخال ذاكرة مشتركة واحد باستخدام مفتاحه الدقيق (المكمل الدقيق ل",
    "Leggi UN elemento della memoria condivisa tramite la sua chiave esatta (il complemento preciso a"
  ],
  [
    "Read the user's shared code-signing credentials (managed on the OwLLM Signing page) so you can",
    "读取用户的共享代码签名凭据（在 OwLLM 签名页面管理），以便您能够",
    "사용자가 공유한 코드 서명 자격 증명(OwLLM 서명 페이지에서 관리)을 읽어, 그래서 당신이",
    "ユーザーの共有コード署名資格情報を読み取ります（OwLLM署名ページで管理されている）",
    "اقرأ بيانات اعتماد توقيع الشفرة المشتركة للمستخدم (تدار في صفحة توقيع OwLLM) حتى تتمكن من",
    "Leggi le credenziali di firma del codice condiviso dell'utente (gestite nella pagina OwLLM Signing) così puoi"
  ],
  [
    "read_file",
    "read_file",
    "파일 읽기",
    "read_file",
    "read_file",
    "read_file"
  ],
  [
    "read-only diagnostics only",
    "仅限读取诊断",
    "읽기 전용 진단만",
    "読み取り専用の診断のみ",
    "تشخيصات للقراءة فقط",
    "solo diagnostica in sola lettura"
  ],
  [
    "Read-only Postgres queries. Edit the LAST arg to your connection URL.",
    "只读 Postgres 查询。编辑最后一个参数为您的连接 URL。",
    "읽기 전용 Postgres 쿼리. 마지막 인수를 연결 URL로 수정하세요.",
    "読み取り専用のPostgresクエリ。接続URLは最後の引数を編集してください。",
    "استعلامات Postgres للقراءة فقط. قم بتحرير الحجة الأخيرة إلى عنوان URL الخاص بالاتصال.",
    "Query Postgres in sola lettura. Modifica l'ULTIMO argomento con la tua URL di connessione."
  ],
  [
    "Readiness check",
    "准备就绪检查",
    "준비 상태 확인",
    "準備状況チェック",
    "فحص الجاهزية",
    "Controllo di prontezza"
  ],
  [
    "Readiness check running… — click to see what's missing",
    "准备检查运行中… — 点击查看缺失内容",
    "준비 상태 확인 실행 중… — 누락된 항목 보기 클릭",
    "準備状況チェック実行中… — 欠落している項目を見るにはクリックしてください",
    "جارٍ تشغيل فحص الاستعداد… — انقر لرؤية ما هو مفقود",
    "Controllo di prontezza in corso… — clicca per vedere cosa manca"
  ],
  [
    "reading notebook...",
    "正在读取笔记本...",
    "노트북 읽는 중...",
    "ノートブックを読み込んでいます…",
    "جارٍ قراءة المفكرة...",
    "lettura del notebook..."
  ],
  [
    "READMEs that don't exist yet.",
    "尚不存在的自述文件。",
    "아직 존재하지 않는 README들.",
    "存在しないREADME。",
    "ملفات README التي لم تُنشأ بعد.",
    "README che non esistono ancora."
  ],
  [
    "reads. One-click needs the",
    "读取。一键需要",
    "읽기. 원클릭 필요",
    "読みます。一クリックが必要です",
    "القراءات. النقر مرة واحدة يحتاج إلى",
    "letture. One-click richiede il"
  ],
  [
    "ready",
    "准备就绪",
    "준비됨",
    "準備完了",
    "جاهز",
    "pronto"
  ],
  [
    "Ready",
    "准备好了",
    "준비 완료",
    "準備完了",
    "جاهز",
    "Pronto"
  ],
  [
    "READY",
    "准备好了",
    "준비 완료",
    "準備完了",
    "جاهز",
    "PRONTO"
  ],
  [
    "Ready. Actions run host-side git — output appears here.",
    "准备就绪。操作在主机端运行 git — 输出显示在这里。",
    "준비됨. 작업이 호스트 측 git에서 실행됨 — 출력이 여기에 표시됩니다.",
    "準備完了。アクションはホスト側でgitを実行します — 出力はここに表示されます。",
    "جاهز. يتم تشغيل الإجراءات على جانب المضيف — تظهر المخرجات هنا.",
    "Pronto. Azioni eseguite lato host git — l'output appare qui."
  ],
  [
    "reboot once",
    "重启一次",
    "한 번 재부팅",
    "一度再起動",
    "أعد التشغيل مرة واحدة ",
    "riavvia una volta"
  ],
  [
    "Rebuildable environments",
    "可重建的环境",
    "재구성 가능한 환경",
    "再構築可能な環境",
    "بيئات قابلة لإعادة البناء ",
    "Ambientazioni ricostruibili"
  ],
  [
    "recall it later (across dispatches AND future runs). Use for stable, reusable",
    "稍后回忆它（跨分派和未来运行）。用于稳定、可复用",
    "나중에 다시 불러오기 (디스패치 및 향후 실행 모두에 걸쳐). 안정적이고 재사용 가능한 용도에 사용",
    "後でそれを呼び出す（ディスパッチおよび将来の実行を通じて）。安定した再利用可能なものに使用",
    "تذكره لاحقًا (عبر الإرساليات والتشغيلات المستقبلية). استخدمه للثبات، وقابلية إعادة الاستخدام ",
    "ricordalo più tardi (tra invii E future esecuzioni). Usalo per stabile, riutilizzabile"
  ],
  [
    "Recent",
    "最近的",
    "최근",
    "最近",
    "الأخيرة ",
    "Recenti"
  ],
  [
    "Reclaim disk space? This physically shrinks the WSL disk file. It will: • RESTART WSL (any running agents stop) • ask for a Windows admin prompt • take up to a minute Tip: press “Clear caches” first so there’s more to reclaim. Continue?",
    "回收磁盘空间？这会物理缩小 WSL 磁盘文件。它将：• 重启 WSL（任何正在运行的代理将停止）• 请求 Windows 管理员权限• 可能需要长达一分钟的小提示：先按“清除缓存”，这样可以回收更多空间。是否继续？",
    "디스크 공간을 회수하시겠습니까? 이는 WSL 디스크 파일을 물리적으로 줄입니다. 다음 작업이 수행됩니다: • WSL 재시작 (실행 중인 모든 에이전트 중지) • Windows 관리자 권한 프롬프트 요청 • 최대 1분 소요 팁: 먼저 “캐시 지우기”를 눌러 회수할 공간을 늘리세요. 계속하시겠습니까?",
    "ディスク領域を回復しますか？これはWSLディスクファイルを物理的に縮小します。以下のことが行われます：• WSLを再起動します（実行中のエージェントは停止します）• Windowsの管理者プロンプトが求められます• 最大1分かかります ヒント：「キャッシュをクリア」を先に押すと、より多くの領域を回復できます。続行しますか？",
    "استعادة مساحة القرص؟ هذا يقلص فعليًا ملف قرص WSL. سيقوم بـ: • إعادة تشغيل WSL (ستتوقف أي وكلاء قيد التشغيل) • طلب مطالبة مسؤول Windows • قد يستغرق حتى دقيقة نصيحة: اضغط على \"مسح الكاشات\" أولاً بحيث يكون هناك المزيد لاستعادته. الاستمرار؟",
    "Recuperare spazio su disco? Questo riduce fisicamente il file del disco WSL. Verrà fatto: • RIAVVIO DI WSL (qualsiasi agente in esecuzione si fermerà) • richiesta di un prompt amministrativo di Windows • può richiedere fino a un minuto Suggerimento: premi prima “Cancella cache” così ci sarà più spazio da recuperare. Continuare?"
  ],
  [
    "recommended",
    "推荐",
    "권장",
    "推奨",
    "موصى به ",
    "consigliato"
  ],
  [
    "Recommended workflows",
    "推荐的工作流程",
    "권장 워크플로",
    "推奨されるワークフロー",
    "إجراءات العمل الموصى بها",
    "Flussi di lavoro consigliati"
  ],
  [
    "Recommended:",
    "推荐：",
    "권장:",
    "推奨：",
    "موصى به: ",
    "Raccomandato:"
  ],
  [
    "Record",
    "记录",
    "기록",
    "記録",
    "سجل ",
    "Registra"
  ],
  [
    "recording",
    "录制中",
    "녹화",
    "録音",
    "تسجيل",
    "registrazione"
  ],
  [
    "Recording the chosen window as-is. For the OWLLM frame, stop and re-record, choosing “Entire Screen”. Ctrl+Shift+R to stop.",
    "按原样录制所选窗口。对于 OWLLM 框架，请停止并重新录制，选择“整个屏幕”。按 Ctrl+Shift+R 停止。",
    "선택한 창을 그대로 녹화 중입니다. OWLLM 프레임의 경우, 중지하고 “전체 화면”을 선택하여 다시 녹화하세요. Ctrl+Shift+R로 중지합니다.",
    "選択したウィンドウをそのまま録画します。OWLLMフレームの場合は、停止して再録画し、「全画面」を選択してください。停止するには Ctrl+Shift+R を押します。",
    "تسجيل النافذة المختارة كما هي. لإطار OWLLM، أوقف وأعد التسجيل، واختر \"الشاشة بأكملها\". اضغط Ctrl+Shift+R للإيقاف.",
    "Registrazione della finestra selezionata così com’è. Per il frame OWLLM, interrompi e registra di nuovo, scegliendo “Schermo intero”. Ctrl+Shift+R per interrompere."
  ],
  [
    "Recording the whole screen. In the share dialog choose “Entire Screen”. Press Ctrl+Shift+R to stop.",
    "录制整个屏幕。在共享对话框中选择“整个屏幕”。按 Ctrl+Shift+R 停止。",
    "전체 화면 녹화 중입니다. 공유 대화상자에서 “전체 화면”을 선택하세요. Ctrl+Shift+R로 중지합니다.",
    "画面全体を録画しています。共有ダイアログで「全画面」を選択してください。停止するには Ctrl+Shift+R を押します。",
    "تسجيل الشاشة كاملة. في مربع الحوار للمشاركة اختر \"الشاشة بأكملها\". اضغط Ctrl+Shift+R للإيقاف.",
    "Registrazione dell’intero schermo. Nella finestra di condivisione scegli “Schermo intero”. Premi Ctrl+Shift+R per interrompere."
  ],
  [
    "Recording.",
    "录制中。",
    "녹화 중.",
    "録画中。",
    "تسجيل.",
    "Registrazione."
  ],
  [
    "Red",
    "红色",
    "빨간색",
    "赤",
    "أحمر",
    "Rosso"
  ],
  [
    "Red Team",
    "红队",
    "레드 팀",
    "レッドチーム",
    "فريق أحمر",
    "Squadra Rossa"
  ],
  [
    "Reference servers maintained by Anthropic. Read the README for the canonical list + setup notes.",
    "由 Anthropic 维护的参考服务器。阅读 README 获取规范列表和设置说明。",
    "Anthropic에서 유지 관리하는 참조 서버. 공식 목록 + 설정 노트는 README를 읽어보세요.",
    "Anthropic が維持するリファレンスサーバー。標準のリストとセットアップノートについては README を参照してください。",
    "الخوادم المرجعية التي تديرها شركة Anthropic. اقرأ ملف README للحصول على القائمة الرسمية وملاحظات الإعداد.",
    "Server di riferimento mantenuti da Anthropic. Leggere il README per la lista canonica + note di configurazione."
  ],
  [
    "Refine the brief, or assemble a team above…",
    "完善简报，或组建一支团队以上…",
    "브리프를 다듬거나, 위에 팀을 구성하세요…",
    "概要を洗練するか、上にチームを組織してください…",
    "صقل الموجز، أو جمع فريق أعلى…",
    "Raffina il brief, o raduna un team superiore…"
  ],
  [
    "Refresh",
    "刷新",
    "새로 고침",
    "更新",
    "تحديث",
    "Aggiorna"
  ],
  [
    "Refresh model lists in every picker",
    "刷新每个选择器中的模型列表",
    "모든 선택기에서 모델 목록을 새로 고침",
    "すべてのピッカーでモデルリストを更新",
    "تحديث قوائم النماذج في كل محدد",
    "Aggiornare le liste dei modelli in ogni selettore"
  ],
  [
    "Regex content search across files under a directory. Returns",
    "在目录下的文件中使用正则表达式进行内容搜索。返回",
    "디렉토리 하위 파일에서 정규식 콘텐츠 검색. 반환함",
    "ディレクトリ内のファイルを対象とした正規表現によるコンテンツ検索。返します",
    "بحث بالمحتوى باستخدام تعبيرات regex عبر الملفات ضمن دليل. يعيد",
    "Ricerca di contenuti regex attraverso file in una directory. Restituisce"
  ],
  [
    "Rejected",
    "被拒绝",
    "거부됨",
    "拒否されました",
    "مرفوض",
    "Rifiutato"
  ],
  [
    "Rejected malformed call: {0}",
    "拒绝的格式错误调用: {0}",
    "잘못된 호출 거부: {0}",
    "不正な呼び出しを拒否しました: {0}",
    "تم رفض الاتصال المشوه: {0}",
    "Chiamata malformata rifiutata: {0}"
  ],
  [
    "Relay",
    "中继",
    "중계",
    "リレー",
    "الترحيل",
    "Relay"
  ],
  [
    "Release (rule-based publish)",
    "发布（基于规则的发布）",
    "릴리스 (규칙 기반 게시)",
    "リリース（ルールベースの公開）",
    "الإصدار (نشر قائم على القواعد)",
    "Rilascio (pubblicazione basata su regole)"
  ],
  [
    "Release notes",
    "发布说明",
    "릴리스 노트",
    "リリースノート",
    "ملاحظات الإصدار",
    "Note di rilascio"
  ],
  [
    "Release notes shown on GitHub + in the updater.",
    "发布说明显示在 GitHub 上 + 更新器中。",
    "GitHub + 업데이트 프로그램에 표시된 릴리스 노트.",
    "GitHub およびアップデータで表示されるリリースノート。",
    "ملاحظات الإصدار المعروضة على GitHub + في المحدث.",
    "Note di rilascio mostrate su GitHub + nell'aggiornamento."
  ],
  [
    "Release repo",
    "发布仓库",
    "릴리스 저장소",
    "リリースリポジトリ",
    "مستودع الإصدار",
    "Repository di rilascio"
  ],
  [
    "Release target repo (Project Card)",
    "发布目标仓库（项目卡片）",
    "릴리스 대상 저장소 (프로젝트 카드)",
    "リリース対象リポジトリ（プロジェクトカード）",
    "مستودع الهدف للإصدار (بطاقة المشروع)",
    "Repository di destinazione del rilascio (Scheda Progetto)"
  ],
  [
    "Release visibility",
    "发布可见性",
    "릴리스 가시성",
    "リリースの可視性",
    "رؤية الإصدار",
    "Visibilità del rilascio"
  ],
  [
    "Reload the current page in the persistent browser. Snapshot afterward to re-read elements.",
    "在持久浏览器中重新加载当前页面。之后快照以重新读取元素。",
    "지속 브라우저에서 현재 페이지를 다시 로드합니다. 이후 요소를 다시 읽기 위해 스냅샷을 찍습니다.",
    "永続ブラウザで現在のページをリロードします。その後、要素を再読み取りするためにスナップショットを取ります。",
    "إعادة تحميل الصفحة الحالية في المتصفح المستمر. أخذ لقطة للمرة الثانية لإعادة قراءة العناصر.",
    "Ricarica la pagina corrente nel browser persistente. Istante dopo per rileggere gli elementi."
  ],
  [
    "REMOTE",
    "远程",
    "원격",
    "リモート",
    "عن بُعد",
    "REMOTO"
  ],
  [
    "Remote console",
    "远程控制台",
    "원격 콘솔",
    "リモートコンソール",
    "وحدة التحكم عن بُعد",
    "Console remota"
  ],
  [
    "remote control disabled",
    "远程控制已禁用",
    "원격 제어 비활성화됨",
    "リモート制御無効",
    "التحكم عن بُعد معطل",
    "controllo remoto disabilitato"
  ],
  [
    "remote control enabled",
    "远程控制已启用",
    "원격 제어 활성화됨",
    "リモート制御有効",
    "التحكم عن بُعد ممكّن",
    "controllo remoto abilitato"
  ],
  [
    "Remote devices audit",
    "远程设备审计",
    "원격 장치 감사",
    "リモートデバイス監査",
    "تدقيق الأجهزة البعيدة",
    "Audit dei dispositivi remoti"
  ],
  [
    "Remote Devices requires the desktop app (Tauri) runtime.",
    "远程设备需要桌面应用程序 (Tauri) 运行时。",
    "원격 장치는 데스크탑 앱(Tauri) 런타임이 필요합니다.",
    "リモートデバイスにはデスクトップアプリ（Tauri）ランタイムが必要です。",
    "الأجهزة البعيدة تتطلب تشغيل تطبيق سطح المكتب (Tauri).",
    "I dispositivi remoti richiedono il runtime dell'app desktop (Tauri)."
  ],
  [
    "Remote host/IP, or a ~/.ssh/config alias.",
    "远程主机/IP，或 ~/.ssh/config 别名。",
    "원격 호스트/IP 또는 ~/.ssh/config 별칭",
    "リモートホスト/IP、または ~/.ssh/config のエイリアス。",
    "المضيف/عنوان IP البعيد، أو اسم مستعار من ~/.ssh/config.",
    "Host/IP remoto o un alias in ~/.ssh/config."
  ],
  [
    "Remote host/IP, or an alias from ~/.ssh/config.",
    "远程主机/IP，或来自 ~/.ssh/config 的别名。",
    "원격 호스트/IP 또는 ~/.ssh/config의 별칭",
    "リモートホスト/IP、または ~/.ssh/config からのエイリアス。",
    "المضيف/عنوان IP البعيد، أو اسم مستعار من ~/.ssh/config.",
    "Host/IP remoto o un alias da ~/.ssh/config."
  ],
  [
    "Remote origin",
    "远程来源",
    "원격 원본",
    "リモートオリジン",
    "الأصل البعيد",
    "Origine remota"
  ],
  [
    "Remote server",
    "远程服务器",
    "원격 서버",
    "リモートサーバー",
    "الخادم البعيد",
    "Server remoto"
  ],
  [
    "REMOTE SHELL",
    "远程终端",
    "원격 셸",
    "リモートシェル",
    "قشرة بعيدة",
    "SHELL REMOTO"
  ],
  [
    "remote_shell",
    "remote_shell",
    "remote_shell",
    "remote_shell",
    "remote_shell",
    "remote_shell"
  ],
  [
    "Remove",
    "移除",
    "제거",
    "削除",
    "إزالة",
    "Rimuovi"
  ],
  [
    "remove {0}: {1}",
    "移除 {0}：{1}",
    "{0} 제거: {1}",
    "{0} を削除: {1}",
    "إزالة {0}: {1}",
    "rimuovi {0}: {1}"
  ],
  [
    "Remove agent",
    "移除代理",
    "에이전트 제거",
    "エージェントを削除",
    "إزالة الوكيل",
    "Rimuovi agente"
  ],
  [
    "Remove from recent projects (keeps files on disk)",
    "从最近项目中移除（保留磁盘上的文件）",
    "최근 프로젝트에서 제거(디스크의 파일은 유지)",
    "最近のプロジェクトから削除（ファイルはディスクに保持されます）",
    "إزالة من المشاريع الأخيرة (يحتفظ بالملفات على القرص)",
    "Rimuovi dai progetti recenti (mantiene i file sul disco)"
  ],
  [
    "Remove from registry",
    "从注册表中移除",
    "레지스트리에서 제거",
    "レジストリから削除",
    "إزالة من السجل",
    "Rimuovi dal registro"
  ],
  [
    "Remove installed skill '{0}'? This deletes LLM/data/skills/{1}/.",
    "移除已安装的技能 '{0}'？这会删除 LLM/data/skills/{1}/。",
    "설치된 스킬 '{0}'를 제거하시겠습니까? 이 작업은 LLM/data/skills/{1}/를 삭제합니다.",
    "インストール済みスキル '{0}' を削除しますか？ これにより LLM/data/skills/{1}/ が削除されます。",
    "هل تريد إزالة المهارة المثبتة '{0}'؟ هذا يحذف LLM/data/skills/{1}/.",
    "Rimuovere la skill installata '{0}'? Questo elimina LLM/data/skills/{1}/."
  ],
  [
    "Remove MCP server '{0}'?",
    "移除 MCP 服务器 '{0}'？",
    "MCP 서버 '{0}'를 제거하시겠습니까?",
    "MCP サーバー '{0}' を削除しますか？",
    "إزالة خادم MCP '{0}'؟",
    "Rimuovere il server MCP '{0}'?"
  ],
  [
    "Remove the local {0} credentials?",
    "删除本地 {0} 凭据？",
    "로컬 {0} 자격 증명을 제거하시겠습니까?",
    "ローカル {0} の認証情報を削除しますか？",
    "إزالة بيانات اعتماد {0} المحلية؟",
    "Rimuovere le credenziali locali {0}?"
  ],
  [
    "Remove the stored Apple signing certificate and passwords from this machine?",
    "从此计算机中删除存储的 Apple 签名证书和密码？",
    "이 기기에서 저장된 Apple 서명 인증서 및 비밀번호를 제거하시겠습니까?",
    "このマシンから保存されている Apple サインイン証明書とパスワードを削除しますか？",
    "إزالة شهادة توقيع آبل وكلمات المرور المخزنة من هذا الجهاز؟",
    "Rimuovere il certificato di firma Apple e le password memorizzate da questa macchina?"
  ],
  [
    "Remove this agent",
    "删除此代理",
    "이 에이전트 제거",
    "このエージェントを削除",
    "إزالة هذا الوكيل",
    "Rimuovere questo agente"
  ],
  [
    "Remove this installed skill",
    "删除此已安装的技能",
    "이 설치된 스킬 제거",
    "このインストール済みスキルを削除",
    "إزالة هذه المهارة المثبتة",
    "Rimuovere questa skill installata"
  ],
  [
    "Remove this saved Node",
    "删除此已保存的节点",
    "이 저장된 노드 제거",
    "この保存済みノードを削除",
    "إزالة هذا العقدة المحفوظة",
    "Rimuovere questo Node salvato"
  ],
  [
    "Removed {0}.",
    "已删除 {0}。",
    "{0}이(가) 제거되었습니다.",
    "{0} を削除しました。",
    "تمت إزالة {0}.",
    "Rimosso {0}."
  ],
  [
    "Removing {0}…",
    "正在移除 {0}…",
    "{0} 제거 중…",
    "{0} を削除中…",
    "جارٍ إزالة {0}…",
    "Rimozione di {0}…"
  ],
  [
    "Rename",
    "重命名",
    "이름 바꾸기",
    "名前を変更",
    "إعادة تسمية",
    "Rinomina"
  ],
  [
    "Rename (display only — folder is unchanged)",
    "重命名（仅显示 — 文件夹保持不变）",
    "이름 바꾸기 (표시만 변경 — 폴더는 그대로)",
    "名前を変更（表示のみ — フォルダは変更されません）",
    "إعادة تسمية (عرض فقط — المجلد لم يتغير)",
    "Rinomina (solo visualizzazione — la cartella non cambia)"
  ],
  [
    "Rename failed: {0}",
    "重命名失败：{0}",
    "이름 바꾸기 실패: {0}",
    "名前の変更に失敗しました: {0}",
    "فشل إعادة التسمية: {0}",
    "Rinomina non riuscita: {0}"
  ],
  [
    "Rename page…",
    "重命名页面…",
    "페이지 이름 바꾸기…",
    "ページの名前を変更…",
    "إعادة تسمية الصفحة…",
    "Rinomina pagina…"
  ],
  [
    "Rename project '{0}' to:",
    "将项目 '{0}' 重命名为：",
    "프로젝트 '{0}'을(를) 다음으로 이름 바꾸기:",
    "プロジェクト '{0}' の名前を変更:",
    "إعادة تسمية المشروع '{0}' إلى:",
    "Rinomina progetto '{0}' in:"
  ],
  [
    "Reopen this step (moves it back to the active feed)",
    "重新打开此步骤（将其移回活动进度）",
    "이 단계를 다시 열기 (활성 피드로 되돌림)",
    "このステップを再度開く（アクティブフィードに戻す）",
    "إعادة فتح هذه الخطوة (ينقلها مرة أخرى إلى الخلاصة النشطة)",
    "Riapri questo passaggio (lo sposta di nuovo nel feed attivo)"
  ],
  [
    "Replacement text.",
    "替换文本。",
    "대체 텍스트.",
    "置換テキスト。",
    "نص الاستبدال.",
    "Testo sostitutivo."
  ],
  [
    "repo",
    "仓库",
    "저장소",
    "リポ",
    "المستودع",
    "repo"
  ],
  [
    "repo (e.g. LLM-Studio)",
    "仓库（例如 LLM-Studio）",
    "저장소 (예: LLM-Studio)",
    "リポ（例: LLM-Studio）",
    "المستودع (مثل LLM-Studio)",
    "repo (es. LLM-Studio)"
  ],
  [
    "repo on",
    "在仓库上",
    "저장소 켜기",
    "リポオン",
    "المستودع في",
    "repo su"
  ],
  [
    "Repo:",
    "仓库：",
    "저장소:",
    "リポジトリ:",
    "المستودع:",
    "Repo:"
  ],
  [
    "report a bug",
    "报告错误",
    "버그 신고",
    "バグを報告",
    "التبليغ عن خطأ",
    "Segnala un bug"
  ],
  [
    "Report a bug",
    "报告一个错误",
    "버그 신고",
    "バグを報告する",
    "الإبلاغ عن خطأ",
    "Segnala un bug"
  ],
  [
    "Report the current page (URL + title + load state) of the persistent browser.",
    "报告持久浏览器的当前页面（URL + 标题 + 加载状态）。",
    "지속 브라우저에서 현재 페이지(URL + 제목 + 로드 상태) 신고",
    "永続的ブラウザの現在のページ（URL + タイトル + ロード状態）を報告",
    "الإبلاغ عن الصفحة الحالية (الرابط + العنوان + حالة التحميل) للمتصفح المستمر.",
    "Segnala la pagina corrente (URL + titolo + stato di caricamento) del browser persistente."
  ],
  [
    "Repository settings + readiness details",
    "仓库设置 + 准备情况详情",
    "저장소 설정 + 준비 상태 세부 정보",
    "リポジトリ設定 + 準備状況の詳細",
    "إعدادات المستودع + تفاصيل الجاهزية",
    "Impostazioni del repository + dettagli di prontezza"
  ],
  [
    "Research",
    "研究",
    "연구",
    "リサーチ",
    "البحث",
    "Ricerca"
  ],
  [
    "researcher",
    "研究员",
    "연구원",
    "研究者",
    "باحث",
    "ricercatore"
  ],
  [
    "reset",
    "重置",
    "재설정",
    "リセット",
    "إعادة تعيين",
    "Reimposta"
  ],
  [
    "Reset",
    "重置",
    "재설정",
    "リセット",
    "إعادة ضبط",
    "Reimposta"
  ],
  [
    "Reset to the role / group default colour",
    "重置为角色/组默认颜色",
    "역할/그룹 기본 색상으로 재설정",
    "役割/グループのデフォルトカラーにリセット",
    "إعادة التعيين إلى اللون الافتراضي للدور / المجموعة",
    "Reimposta al colore predefinito del ruolo / gruppo"
  ],
  [
    "Reset zoom + pan",
    "重置缩放 + 平移",
    "줌 및 이동 재설정",
    "ズーム＋パンをリセット",
    "إعادة تعيين التكبير + التحريك",
    "Reimposta zoom + panoramica"
  ],
  [
    "Resetting…",
    "重置中…",
    "재설정 중…",
    "リセット中…",
    "إعادة الضبط…",
    "Ripristino…"
  ],
  [
    "Restart and press",
    "重启并按",
    "다시 시작하고 누르기",
    "再起動して押す",
    "أعد التشغيل واضغط",
    "Riavvia e premi"
  ],
  [
    "Restart the model server",
    "重启模型服务器",
    "모델 서버 다시 시작",
    "モデルサーバーを再起動",
    "إعادة تشغيل خادم النموذج",
    "Riavvia il server del modello"
  ],
  [
    "Restart the server to apply the new context size.",
    "重新启动服务器以应用新的上下文大小。",
    "새 컨텍스트 크기를 적용하려면 서버를 다시 시작하십시오.",
    "新しいコンテキストサイズを適用するためにサーバーを再起動",
    "أعد تشغيل الخادم لتطبيق حجم السياق الجديد.",
    "Riavvia il server per applicare la nuova dimensione del contesto."
  ],
  [
    "Resume",
    "恢复",
    "재개",
    "再開",
    "استئناف",
    "Riprendi"
  ],
  [
    "Retry",
    "重试",
    "재시도",
    "再試行",
    "أعد المحاولة",
    "Riprova"
  ],
  [
    "retry-goal",
    "重试目标",
    "재시도-목표",
    "再試行-目標",
    "إعادة محاولة الهدف",
    "ritenta-obiettivo"
  ],
  [
    "Return the visible text content of the current page in the persistent browser.",
    "返回持久浏览器中当前页面的可见文本内容。",
    "지속 브라우저에서 현재 페이지의 표시 텍스트 내용을 반환",
    "現在のページの表示テキスト内容を永続的なブラウザに返す",
    "أعد محتوى النص الظاهر للصفحة الحالية في المتصفح المستمر.",
    "Restituisci il contenuto testuale visibile della pagina corrente nel browser persistente."
  ],
  [
    "Returns stdout, stderr, exit_code. Use for git, npm install, python",
    "返回 stdout、stderr、exit_code。用于 git、npm install、python",
    "stdout, stderr, exit_code 반환. git, npm install, python에 사용",
    "stdout、stderr、exit_codeを返す。git、npm install、pythonに使用",
    "يعيد stdout و stderr ورمز الخروج. استخدمه لـ git و npm install و python",
    "Restituisce stdout, stderr, exit_code. Usalo per git, npm install, python"
  ],
  [
    "Returns the saved PNG path. Use this to capture competitor GUIs",
    "返回保存的 PNG 路径。用来捕获竞争对手的 GUI",
    "저장된 PNG 경로를 반환. 경쟁사 GUI를 캡처할 때 사용",
    "保存されたPNGのパスを返す。競合他社のGUIをキャプチャするのに使用",
    "يعيد مسار PNG المحفوظ. استخدم هذا لالتقاط واجهات المستخدم الخاصة بالمنافسين",
    "Restituisce il percorso PNG salvato. Usalo per catturare le GUI dei concorrenti"
  ],
  [
    "Returns the script log; success ends with PUBLISH_OK. Use dry_run='true' first",
    "返回脚本日志；成功以 PUBLISH_OK 结束。先使用 dry_run='true'",
    "스크립트 로그를 반환합니다; 성공하면 PUBLISH_OK로 종료됩니다. 먼저 dry_run='true'를 사용하세요",
    "スクリプトログを返します。成功するとPUBLISH_OKで終了します。最初にdry_run='true'を使用してください",
    "يعيد سجل السكريبت؛ النجاح ينتهي بـ PUBLISH_OK. استخدم dry_run='true' أولاً",
    "Restituisce il registro degli script; il successo termina con PUBLISH_OK. Usa prima dry_run='true'"
  ],
  [
    "review",
    "复审",
    "검토",
    "レビュー",
    "مراجعة",
    "revisione"
  ],
  [
    "review before applying",
    "应用前复审",
    "적용 전에 검토",
    "適用前にレビュー",
    "مراجعة قبل التطبيق",
    "revisiona prima di applicare"
  ],
  [
    "Reviewing…",
    "正在查看…",
    "검토 중…",
    "レビュー中…",
    "جارٍ المراجعة…",
    "Revisione…"
  ],
  [
    "reviews work, challenges assumptions, catches problems early",
    "复审工作、挑战假设、及早发现问题",
    "검토는 작업을 수행하고, 가정을 도전하며, 문제를 조기에 발견합니다",
    "レビューは機能し、仮定に挑戦し、問題を早期に発見します",
    "المراجعات تعمل، تتحدى الافتراضات، وتكتشف المشاكل مبكرًا",
    "Le revisioni funzionano, mettono in discussione le assunzioni, rilevano problemi precocemente"
  ],
  [
    "Revoke",
    "撤销",
    "취소",
    "取り消す",
    "إلغاء",
    "Revoca"
  ],
  [
    "Revoke consent for this host",
    "撤销对此主机的授权",
    "이 호스트에 대한 동의 취소",
    "このホストへの同意を取り消す",
    "إلغاء الموافقة لهذا المضيف",
    "Revoca il consenso per questo host"
  ],
  [
    "revoked",
    "已撤销",
    "취소됨",
    "取り消されました",
    "تم إلغاء",
    "Revocato"
  ],
  [
    "Revoked",
    "已撤销",
    "취소됨",
    "取り消された",
    "ملغى",
    "Revocato"
  ],
  [
    "Right Panel",
    "右侧面板",
    "오른쪽 패널",
    "右側パネル",
    "اللوحة اليمنى",
    "Pannello destro"
  ],
  [
    "role",
    "角色",
    "역할",
    "役割",
    "الدور",
    "ruolo"
  ],
  [
    "Role base",
    "基于角色",
    "역할 기반",
    "役割ベース",
    "قاعدة الدور",
    "Base del ruolo"
  ],
  [
    "Root:",
    "根：",
    "루트:",
    "ルート:",
    "الجذر:",
    "Radice:"
  ],
  [
    "Roots:",
    "根：",
    "루트들:",
    "ルーツ:",
    "الجذور:",
    "Radici:"
  ],
  [
    "Roster · loadout",
    "名册 · 装备",
    "명단 · 장비",
    "名簿・装備",
    "قائمة الحضور · التجهيز",
    "Roster · equipaggiamento"
  ],
  [
    "ROUTING",
    "路由",
    "라우팅",
    "ルーティング",
    "التوجيه",
    "ROUTING"
  ],
  [
    "rules",
    "规则",
    "규칙",
    "ルール",
    "القواعد",
    "Regole"
  ],
  [
    "Rules",
    "规则",
    "규칙",
    "ルール",
    "قواعد",
    "Regole"
  ],
  [
    "Rules are injected into every agent on the active team (",
    "规则被注入到活动团队的每个代理中（",
    "규칙은 활성 팀의 모든 에이전트에 주입됩니다 (",
    "ルールはアクティブチームのすべてのエージェントに注入されます（",
    "يتم حقن القواعد في كل وكيل في الفريق النشط (",
    "Le regole vengono inserite in ogni agente del team attivo ("
  ],
  [
    "run",
    "运行",
    "실행",
    "実行",
    "تشغيل",
    "eseguire"
  ],
  [
    "Run `gh auth login` to enable secret pushing and releases.",
    "运行 `gh auth login` 以启用秘密推送和发布。",
    "비밀 푸시 및 릴리스를 활성화하려면 `gh auth login`을 실행하세요.",
    "シークレットのプッシュとリリースを有効にするには、`gh auth login` を実行してください。",
    "قم بتشغيل `gh auth login` لتمكين دفع الأسرار والإصدارات.",
    "Esegui `gh auth login` per abilitare l'invio di segreti e le versioni."
  ],
  [
    "Run a shell command on a PAIRED OwLLM device — another PC running OwLLM that",
    "在配对的 OwLLM 设备上运行 shell 命令——另一台运行 OwLLM 的电脑",
    "PAIRED OwLLM 장치에서 셸 명령 실행 — OwLLM이 실행 중인 다른 PC",
    "ペアリングされた OwLLM デバイスでシェルコマンドを実行します — もう一台の OwLLM を実行している PC",
    "قم بتشغيل أمر شل على جهاز OwLLM مُقارن — كمبيوتر آخر يعمل على OwLLM الذي",
    "Esegui un comando shell su un dispositivo OwLLM ABBINATO — un altro PC che esegue OwLLM che"
  ],
  [
    "Run a shell command on a REMOTE host over SSH, using the user's existing",
    "在远程主机上通过 SSH 运行 shell 命令，使用用户现有的",
    "사용자의 기존을 사용하여 SSH를 통해 원격 호스트에서 셸 명령 실행",
    "ユーザーの既存の設定を使用して、SSH 経由でリモートホストでシェルコマンドを実行します",
    "قم بتشغيل أمر شل على مضيف بعيد عبر SSH، باستخدام بيانات الاعتماد الموجودة للمستخدم",
    "Esegui un comando shell su un host REMOTO tramite SSH, utilizzando l'utente esistente"
  ],
  [
    "Run a shell command. On Windows uses cmd.exe /c, elsewhere sh -c.",
    "运行 shell 命令。在 Windows 上使用 cmd.exe /c，其他地方使用 sh -c。",
    "셸 명령 실행. Windows에서는 cmd.exe /c, 다른 곳에서는 sh -c 사용.",
    "シェルコマンドを実行します。Windows では cmd.exe /c を使用し、その他では sh -c を使用します。",
    "قم بتشغيل أمر شل. على ويندوز يستخدم cmd.exe /c، وفي الأماكن الأخرى sh -c.",
    "Esegui un comando shell. Su Windows usa cmd.exe /c, altrove sh -c."
  ],
  [
    "Run an agentic team — completed runs land here and grant XP that unlocks new scenes.",
    "运行一个自主团队——完成的运行结果会落在这里，并授予解锁新场景的经验值（XP）。",
    "에이전트 팀 실행 — 완료된 실행은 여기에 위치하며 새로운 장면을 잠금 해제하는 XP를 부여합니다.",
    "エージェントチームを実行します — 完了した実行はここに届き、XP を付与し新しいシーンをアンロックします。",
    "قم بتشغيل فريق وكيل — عمليات التشغيل المكتملة تصل هنا وتمنح نقاط خبرة تفتح مشاهد جديدة.",
    "Esegui un team agentico — le esecuzioni completate finiscono qui e concedono XP che sbloccano nuove scene."
  ],
  [
    "Run command: {0}",
    "运行命令：{0}",
    "명령 실행: {0}",
    "コマンドを実行: {0}",
    "تشغيل الأمر: {0}",
    "Esegui comando: {0}"
  ],
  [
    "Run in WSL",
    "在 WSL 中运行",
    "WSL에서 실행",
    "WSL で実行",
    "قم بالتشغيل في WSL",
    "Esegui in WSL"
  ],
  [
    "Run list_skills first if you're unsure what's available.",
    "如果不确定有哪些可用功能，先运行 list_skills。",
    "사용 가능한 것이 확실하지 않으면 먼저 list_skills를 실행하세요.",
    "利用可能なものが不明な場合は、まず list_skills を実行してください。",
    "قم بتشغيل list_skills أولاً إذا لم تكن متأكدًا مما هو متاح.",
    "Esegui list_skills prima se non sei sicuro di cosa sia disponibile."
  ],
  [
    "run live — steps steer it",
    "运行实时 — 步骤引导它",
    "실시간 실행 — 단계가 이를 조종함",
    "ライブ実行 — 手順で操作する",
    "قم بتشغيل live — خطوات توجيهها",
    "eseguire in diretta — passaggi guidali"
  ],
  [
    "Run name",
    "运行名称",
    "실행 이름",
    "実行名",
    "قم بتشغيل name",
    "Esegui nome"
  ],
  [
    "Run targeted checks: venv, GPU, torch-vs-GPU architecture, every package",
    "运行针对性检查：venv、GPU、torch 与 GPU 架构、每个软件包",
    "대상 검사 실행: venv, GPU, torch-대-GPU 아키텍처, 모든 패키지",
    "ターゲットチェックを実行：venv、GPU、torch対GPUアーキテクチャ、すべてのパッケージ",
    "قم بتشغيل الفحوص المستهدفة: venv، GPU، torch-vs-GPU architecture، كل حزمة",
    "Esegui controlli mirati: venv, GPU, architettura torch-vs-GPU, ogni pacchetto"
  ],
  [
    "Run the Steward's deterministic lint against the card + repo",
    "针对卡片和仓库运行管家的确定性 lint 检查",
    "Steward의 결정론적 린트를 카드 + 레포에 대해 실행",
    "カード＋リポジトリに対してStewardの決定論的リントを実行",
    "قم بتشغيل مدقق القواعد الحتمي الخاص بـ Steward على البطاقة + المستودع",
    "Esegui il lint deterministico dello Steward contro la scheda + repo"
  ],
  [
    "running",
    "正在运行",
    "실행 중",
    "実行中",
    "جارٍ التشغيل",
    "esecuzione"
  ],
  [
    "Running",
    "跑步",
    "달리기",
    "走ること",
    "الجري",
    "Correre"
  ],
  [
    "Running — elapsed time",
    "运行中 — 已经过去的时间",
    "실행 중 — 경과 시간",
    "実行中 — 経過時間",
    "جارٍ التشغيل — الوقت المنقضي",
    "In esecuzione — tempo trascorso"
  ],
  [
    "Running — gateway connected.{0}",
    "运行中 — 网关已连接.{0}",
    "실행 중 — 게이트웨이 연결됨.{0}",
    "実行中 — ゲートウェイ接続済み.{0}",
    "جارٍ التشغيل — البوابة متصلة.{0}",
    "In esecuzione — gateway connesso.{0}"
  ],
  [
    "Running — last update_id {0}.{1}",
    "运行中 — 上次更新_id {0}.{1}",
    "실행 중 — 마지막 update_id {0}.{1}",
    "実行中 — 最終更新ID {0}.{1}",
    "جارٍ التشغيل — آخر update_id {0}.{1}",
    "In esecuzione — ultimo update_id {0}.{1}"
  ],
  [
    "Running — polling {0} every {1}s.{2}",
    "运行中 — 每 {1} 秒轮询 {0}.{2}",
    "실행 중 — {1}초마다 {0} 폴링 중.{2}",
    "実行中 — {1}秒ごとに{0}をポーリング中.{2}",
    "جارٍ التشغيل — التحقق {0} كل {1} ثانية.{2}",
    "In esecuzione — polling {0} ogni {1}s.{2}"
  ],
  [
    "Running — Socket Mode connected.{0}",
    "运行中 — 套接字模式已连接.{0}",
    "실행 중 — 소켓 모드 연결됨.{0}",
    "実行中 — ソケットモード接続済み.{0}",
    "جارٍ التشغيل — وضع Socket متصل.{0}",
    "In esecuzione — Modalità Socket connessa.{0}"
  ],
  [
    "Running — webhook callback URL = <tunnel>/line.",
    "运行中 — webhook 回调 URL = <隧道>/line.",
    "실행 중 — webhook 콜백 URL = <tunnel>/line.",
    "実行中 — webhook コールバックURL = <tunnel>/line.",
    "جارٍ التشغيل — عنوان URL لاستدعاء webhook = <tunnel>/line.",
    "In esecuzione — URL di callback webhook = <tunnel>/line."
  ],
  [
    "running ·",
    "运行 ·",
    "실행 중 ·",
    "実行中 ·",
    "تشغيل ·",
    "esecuzione ·"
  ],
  [
    "Running probe…",
    "正在运行探针…",
    "프로브 실행 중…",
    "プローブ実行中…",
    "تشغيل الفحص...",
    "Esecuzione probe…"
  ],
  [
    "Running…",
    "运行中…",
    "실행 중…",
    "実行中…",
    "التشغيل...",
    "Esecuzione…"
  ],
  [
    "Runs ~32 \"harmful\" + ~32 \"harmless\" prompts through it.",
    "运行约32个“有害”+约32个“无害”提示。",
    "~32개의 \"유해\" + ~32개의 \"무해\" 프롬프트를 통과시킵니다.",
    "~32の「有害」+ ~32の「無害」プロンプトを通過させます。",
    "يشغل حوالي 32 من الموجهات \"الضارة\" + حوالي 32 من الموجهات \"الآمنة\" من خلالها.",
    "Esegue circa 32 prompt \"nocivi\" + circa 32 prompt \"innocui\"."
  ],
  [
    "runs on the selected device, not this one",
    "在选定的设备上运行，而不是此设备",
    "선택한 장치에서 실행되며, 이 장치에서는 실행되지 않습니다.",
    "選択したデバイスで実行され、このデバイスでは実行されません",
    "يتم التشغيل على الجهاز المحدد، وليس هذا الجهاز",
    "esegue sul dispositivo selezionato, non su questo"
  ],
  [
    "runs tools + external actions (shell, web, integrations)",
    "运行工具 + 外部操作（shell、网络、集成）",
    "도구 및 외부 작업(셸, 웹, 통합)을 실행합니다.",
    "ツール+外部アクション（シェル、ウェブ、統合）を実行します",
    "يشغل الأدوات + الإجراءات الخارجية (شل، ويب، تكاملات)",
    "esegue strumenti + azioni esterne (shell, web, integrazioni)"
  ],
  [
    "Runtime",
    "运行时间",
    "런타임",
    "ランタイム",
    "وقت التشغيل",
    "Tempo di esecuzione"
  ],
  [
    "Runtime (RTX 4090-class GPU):",
    "运行时（RTX 4090级GPU）：",
    "런타임(RTX 4090급 GPU):",
    "ランタイム（RTX 4090クラスGPU）：",
    "وقت التشغيل (بطاقة رسومات من فئة RTX 4090):",
    "Tempo di esecuzione (GPU classe RTX 4090):"
  ],
  [
    "Runtime tools",
    "运行时工具",
    "런타임 도구",
    "ランタイムツール",
    "أدوات وقت التشغيل",
    "Strumenti di esecuzione"
  ],
  [
    "Rust regex to match against each line.",
    "使用Rust正则表达式匹配每一行。",
    "Rust 정규식을 사용하여 각 줄과 비교합니다.",
    "各行に対して一致するRust正規表現",
    "تعبير نمطي بلغة Rust لمطابقة كل سطر.",
    "Rust regex per confrontare ogni riga."
  ],
  [
    "s · last:",
    "s · 上次：",
    "s · 마지막:",
    "s · 最後：",
    "أخيرًا:",
    "s · ultimo:"
  ],
  [
    "s elapsed",
    "s 已用时间",
    "s 경과",
    "s 経過",
    "الوقت المستغرق",
    "tempo trascorso s"
  ],
  [
    "Safe cleanup",
    "安全清理",
    "안전한 정리",
    "安全なクリーンアップ",
    "تنظيف آمن",
    "Pulizia sicura"
  ],
  [
    "same key",
    "相同的密钥",
    "동일한 키",
    "同じキー",
    "نفس المفتاح",
    "stessa chiave"
  ],
  [
    "Sampling temperature for this agent's model calls. 0.0 = deterministic (good for code, math, planning). 0.7 = balanced. 1.2 = creative / brainstormy. Leave empty for the per-task default (about 0.4 for orchestrators, 0.7 for prose).",
    "此代理模型调用的采样温度。0.0 = 确定性（适用于代码、数学、计划）。0.7 = 平衡。1.2 = 创造性 / 头脑风暴。留空以使用每个任务的默认值（协调器约为0.4，散文约为0.7）。",
    "이 에이전트 모델 호출의 샘플링 온도. 0.0 = 결정적(코드, 수학, 계획에 적합). 0.7 = 균형 잡힘. 1.2 = 창의적 / 브레인스토밍에 적합. 작업별 기본값(오케스트레이터는 약 0.4, 산문은 0.7)을 사용하려면 비워 두세요.",
    "このエージェントのモデル呼び出しのサンプリング温度。0.0 = 決定論的（コード、数学、計画に適している）。0.7 = バランス。1.2 = 創造的／ブレインストーミング向き。課題ごとのデフォルト（オーケストレーターは約0.4、文章は約0.7）を使う場合は空欄のままにします。",
    "درجة العينة لنموذج هذا الوكيل. 0.0 = حتمي (جيد للكود، الرياضيات، التخطيط). 0.7 = متوازن. 1.2 = إبداعي / عصف ذهني. اتركه فارغًا للقيمة الافتراضية لكل مهمة (حوالي 0.4 للمنسقين، 0.7 للنصوص).",
    "Temperatura di campionamento per le chiamate del modello di questo agente. 0,0 = deterministico (buono per codice, matematica, pianificazione). 0,7 = equilibrato. 1,2 = creativo / brainstorming. Lascia vuoto per il valore predefinito per attività (circa 0,4 per gli orchestratori, 0,7 per la prosa)."
  ],
  [
    "Sandboxed file ops. Edit the LAST positional arg to set the allowed root dir.",
    "沙箱文件操作。编辑最后一个位置参数以设置允许的根目录。",
    "샌드박스 파일 작업. 허용된 루트 디렉토리를 설정하려면 마지막 위치 인수를 편집하세요.",
    "サンドボックス化されたファイル操作。許可されるルートディレクトリを設定するには、最後の位置引数を編集してください。",
    "عمليات الملفات المعزولة. حرر آخر وسيطة موقعية لتعيين الدليل الجذري المسموح به.",
    "Operazioni di file in sandbox. Modifica l'ULTIMO argomento posizionale per impostare la directory principale consentita."
  ],
  [
    "SANITIZED",
    "已清理",
    "SANITIZED",
    "消去済み",
    "تم تنظيفها",
    "SANITIZZATO"
  ],
  [
    "save",
    "保存",
    "저장",
    "保存",
    "حفظ",
    "Salva"
  ],
  [
    "Save",
    "保存",
    "저장",
    "保存",
    "حفظ",
    "Salva"
  ],
  [
    "Save & exit. Back in Windows, click",
    "保存并退出。在 Windows 中，点击",
    "저장 후 종료. Windows로 돌아가서 클릭하세요",
    "保存して終了。Windows に戻ったら、クリックしてください",
    "احفظ واخرج. عند العودة إلى ويندوز، انقر",
    "Salva e esci. Tornato in Windows, clicca"
  ],
  [
    "Save a durable fact to the SHARED TEAM MEMORY so you and other agents can",
    "将持久事实保存到共享团队记忆中，以便你和其他代理都可以",
    "공유 팀 메모리에 영구 정보를 저장하여 당신과 다른 에이전트가 사용할 수 있습니다",
    "共有チームメモリに永続的な事実を保存して、あなたや他のエージェントが利用できるようにします",
    "احفظ حقيقة دائمة إلى ذاكرة الفريق المشتركة حتى تستطيع أنت والوكلاء الآخرون",
    "Salva un fatto durevole nella MEMORIA DI SQUADRA CONDIVISA in modo che tu e altri agenti possiate"
  ],
  [
    "Save all",
    "全部保存",
    "모두 저장",
    "すべて保存",
    "حفظ الكل",
    "Salva tutto"
  ],
  [
    "Save as new…",
    "另存为新文件…",
    "새로 저장…",
    "新規として保存…",
    "حفظ كجديد…",
    "Salva come nuovo…"
  ],
  [
    "Save as…",
    "另存为…",
    "다른 이름으로 저장…",
    "名前を付けて保存…",
    "حفظ كـ…",
    "Salva come…"
  ],
  [
    "Save card",
    "保存卡片",
    "카드 저장",
    "カードを保存",
    "حفظ البطاقة",
    "Salva scheda"
  ],
  [
    "Save changes",
    "保存更改",
    "변경 사항 저장",
    "変更を保存",
    "حفظ التغييرات",
    "Salva modifiche"
  ],
  [
    "Save changes to disk",
    "保存更改到磁盘",
    "디스크에 변경 사항 저장하기",
    "ディスクに変更を保存",
    "حفظ التغييرات على القرص",
    "Salva modifiche su disco"
  ],
  [
    "Save changes to this team",
    "保存更改到此团队",
    "이 팀에 변경 사항 저장하기",
    "このチームに変更を保存",
    "حفظ التغييرات في هذا الفريق",
    "Salva modifiche a questo team"
  ],
  [
    "Save chat as JSON",
    "将聊天保存为 JSON",
    "채팅을 JSON으로 저장하기",
    "チャットをJSONとして保存",
    "حفظ الدردشة كملف JSON",
    "Salva chat come JSON"
  ],
  [
    "Save dataset (JSONL)",
    "保存数据集（JSONL）",
    "데이터셋 저장하기 (JSONL)",
    "データセットを保存（JSONL）",
    "حفظ مجموعة البيانات (JSONL)",
    "Salva dataset (JSONL)"
  ],
  [
    "Save failed:",
    "保存失败：",
    "저장 실패:",
    "保存に失敗しました：",
    "فشل الحفظ:",
    "Salvataggio fallito:"
  ],
  [
    "Save failed: {0}",
    "保存失败：{0}",
    "저장 실패: {0}",
    "保存に失敗しました：{0}",
    "فشل الحفظ: {0}",
    "Salvataggio fallito: {0}"
  ],
  [
    "Save in place",
    "就地保存",
    "제자리에서 저장",
    "その場で保存",
    "الحفظ في مكانه",
    "Salva in sede"
  ],
  [
    "Save instruction template as:",
    "将指令模板另存为：",
    "사용자 지정 템플릿으로 저장:",
    "指示テンプレートを次のように保存：",
    "حفظ قالب التعليمات كـ:",
    "Salva modello di istruzione come:"
  ],
  [
    "Save login",
    "保存登录信息",
    "로그인 정보 저장",
    "ログイン情報を保存",
    "حفظ تسجيل الدخول",
    "Salva login"
  ],
  [
    "Save plan + clear notes",
    "保存计划并清除笔记",
    "계획 저장 + 메모 삭제",
    "プランを保存してメモをクリア",
    "حفظ الخطة + مسح الملاحظات",
    "Salva piano + cancella note"
  ],
  [
    "Save the current Port / Token / Root / LAN settings to disk so they survive a restart.",
    "将当前端口 / 令牌 / 根目录 / 局域网设置保存到磁盘，以便重启后依然有效。",
    "현재 포트 / 토큰 / 루트 / LAN 설정을 디스크에 저장하여 재시작 후에도 유지되도록 하기",
    "現在のポート / トークン / ルート / LAN 設定をディスクに保存し、再起動後も維持",
    "حفظ إعدادات المنفذ / الرمز / الجذر / الشبكة المحلية الحالية على القرص لتبقى بعد إعادة التشغيل.",
    "Salva le impostazioni correnti di Porta / Token / Root / LAN su disco in modo che sopravvivano a un riavvio."
  ],
  [
    "Save the current system prompt as a new named template",
    "将当前系统提示保存为新的命名模板",
    "현재 시스템 프롬프트를 새로운 이름의 템플릿으로 저장하기",
    "現在のシステムプロンプトを新しい名前付きテンプレートとして保存",
    "حفظ موجه النظام الحالي كقالب جديد مسمى",
    "Salva il prompt di sistema attuale come nuovo modello nominato"
  ],
  [
    "Save your edits in place — writes an editable override the app loads instead of the bundled file",
    "将你的编辑就地保存——写入一个可编辑的覆盖文件，应用加载该文件而不是捆绑的文件",
    "편집한 내용을 제자리에서 저장 — 앱이 번들 파일 대신 수정 가능한 오버라이드를 불러오도록 작성",
    "編集をその場で保存 — アプリがバンドルファイルの代わりに読み込む編集可能なオーバーライドを書き込み",
    "حفظ تعديلاتك في مكانها — يكتب تجاوزًا قابلًا للتحرير تقوم التطبيق بتحميله بدل الملف المدمج",
    "Salva le modifiche sul posto — scrive una sovrascrittura modificabile che l'app carica invece del file incluso"
  ],
  [
    "save: {0}",
    "保存: {0}",
    "저장: {0}",
    "保存: {0}",
    "حفظ: {0}",
    "salva: {0}"
  ],
  [
    "saved",
    "已保存",
    "저장됨",
    "保存済み",
    "تم الحفظ",
    "salvato"
  ],
  [
    "Saved logins live encrypted on this machine and are only ever injected straight into the matching page inside the OwLLM browser — they never appear here or leave the vault. They power every \"Open … portal\" button on this page, and the agents' browser too.",
    "保存的登录信息以加密形式存储在本机上，只会直接注入到 OwLLM 浏览器中匹配的页面 —— 它们绝不会出现在这里或离开保险库。它们为此页面上的每个 “打开 … 门户” 按钮提供支持，也为代理的浏览器提供支持。",
    "저장된 로그인은 이 기기에서 암호화된 상태로 유지되며, 오직 OwLLM 브라우저 내에서 해당 페이지에 직접 주입됩니다 — 여기에서 나타나거나 금고를 떠나지 않습니다. 이 로그인들은 이 페이지의 모든 \"열기 … 포털\" 버튼과 에이전트의 브라우저에도 사용됩니다.",
    "保存されたログイン情報はこのマシン上で暗号化されて保持され、OwLLMブラウザ内の一致するページに直接注入されるだけで、ここに表示されたりボールトを離れることはありません。これらはこのページ上のすべての「Open … portal」ボタンとエージェントのブラウザの操作にも使用されます。",
    "تُحفظ بيانات تسجيل الدخول مباشرة مشفرة على هذه الآلة ولا يتم حقنها إلا مباشرة في الصفحة المطابقة داخل متصفح OwLLM — لا تظهر هنا أبدًا أو تغادر الخزنة. هذه البيانات تدعم كل زر \"افتح … بوابة\" في هذه الصفحة، ومتصفح الوكلاء أيضًا.",
    "I login salvati vivono criptati su questa macchina e vengono iniettati direttamente nella pagina corrispondente all'interno del browser OwLLM — non compaiono mai qui né lasciano il caveau. Alimentano ogni pulsante \"Apri … portale\" su questa pagina, e anche il browser degli agenti."
  ],
  [
    "Saved logins the agents can autofill. Stored encrypted on this device (DPAPI on Windows). Passwords are never shown here.",
    "已保存的登录信息可由代理自动填写。加密存储在此设备上（Windows 使用 DPAPI）。密码在此处永远不会显示。",
    "에이전트가 자동 완성할 수 있는 저장된 로그인. 이 기기에 암호화되어 저장됨(Windows의 DPAPI). 비밀번호는 여기에서 절대 표시되지 않습니다.",
    "エージェントが自動入力できる保存済みログイン情報。デバイス上に暗号化されて保存（WindowsではDPAPIを使用）。パスワードはここには表示されません。",
    "بيانات تسجيل الدخول المحفوظة التي يمكن للوكلاء ملؤها تلقائيًا. مخزنة مشفرة على هذا الجهاز (DPAPI على ويندوز). كلمات المرور لا تُعرض هنا أبدًا.",
    "Login salvati che gli agenti possono completare automaticamente. Memorizzati criptati su questo dispositivo (DPAPI su Windows). Le password non vengono mai mostrate qui."
  ],
  [
    "Saved Nodes — connection + login the agents autofill (so \"screenshot the KVM\" just works, no IP/port/password guessing). The password is encrypted on this PC and never shown to agents or the UI.",
    "保存的节点 —— 代理自动填写的连接 + 登录信息（因此 “截图 KVM” 功能可以直接使用，无需猜测 IP/端口/密码）。密码在此 PC 上加密，绝不显示给代理或用户界面。",
    "저장된 노드 — 에이전트가 자동 완성하는 연결 + 로그인(따라서 \"KVM 스크린샷 찍기\"가 그냥 작동하며, IP/포트/비밀번호 추측이 필요 없음). 비밀번호는 이 PC에서 암호화되며 에이전트나 UI에 절대 표시되지 않습니다.",
    "保存されたノード — エージェントが自動入力する接続情報＋ログイン情報（「KVMをスクリーンショット」するだけで動作し、IP/ポート/パスワードを推測する必要はありません）。パスワードはこのPC上で暗号化されており、エージェントやUIには表示されません。",
    "العقد المحفوظة — الاتصال + بيانات تسجيل الدخول التي يملؤها الوكلاء تلقائيًا (لذا \"التقاط لقطة للشاشة لجهاز KVM\" تعمل ببساطة، دون تخمين عنوان IP/المنفذ/كلمة المرور). يتم تشفير كلمة المرور على هذا الكمبيوتر ولا تُعرض للوكلاء أو واجهة المستخدم.",
    "Nodi salvati — connessione + login che gli agenti compilano automaticamente (quindi \"fare screenshot del KVM\" funziona semplicemente, senza indovinare IP/porta/password). La password è criptata su questo PC e non viene mai mostrata agli agenti o all'interfaccia utente."
  ],
  [
    "Saved to:",
    "已保存到：",
    "저장 위치:",
    "保存先:",
    "تم الحفظ في:",
    "Salvato in:"
  ],
  [
    "Saved video and click track.",
    "已保存视频和点击轨迹。",
    "저장된 비디오 및 클릭 트랙.",
    "保存されたビデオおよびクリックトラック。",
    "الفيديو ومسار النقر المحفوظ.",
    "Video salvato e tracciamento dei click."
  ],
  [
    "Saves the modified weights to a fresh transformers directory — runnable / quantizable / fine-tunable like any other model.",
    "将修改过的权重保存到一个新的 transformers 目录中——可以像任何其他模型一样运行 / 量化 / 微调。",
    "수정된 가중치를 새로운 transformers 디렉토리에 저장 — 다른 모델처럼 실행 가능 / 양자화 가능 / 미세 조정 가능.",
    "変更された重みを新しい transformers ディレクトリに保存します — 他のモデルと同様に実行可能 / 量子化可能 / ファインチューニング可能です。",
    "يحفظ الأوزان المعدلة في دليل Transformers جديد — قابل للتشغيل / قابل للكمية / قابل للتعديل مثل أي نموذج آخر.",
    "Salva i pesi modificati in una nuova directory di transformers — eseguibile / quantizzabile / ottimizzabile come qualsiasi altro modello."
  ],
  [
    "saving",
    "正在保存",
    "저장",
    "保存中",
    "يجري الحفظ",
    "salvataggio"
  ],
  [
    "Saving recording...",
    "正在保存录制内容...",
    "녹음 저장 중...",
    "録音を保存しています…",
    "جاري حفظ التسجيل...",
    "Salvataggio registrazione..."
  ],
  [
    "Saving…",
    "保存中…",
    "저장 중…",
    "保存中…",
    "جاري الحفظ…",
    "Salvataggio…"
  ],
  [
    "Scan",
    "扫描",
    "스캔",
    "スキャン",
    "مسح",
    "Scansione"
  ],
  [
    "scanning…",
    "扫描中…",
    "스캔 중…",
    "スキャン中…",
    "جارٍ المسح...",
    "Scansione…"
  ],
  [
    "Scanning…",
    "扫描中…",
    "스캔하는 중…",
    "スキャン中…",
    "جارٍ المسح…",
    "Scansione…"
  ],
  [
    "Schema was auto-sanitized so it can't break tool-calling: {0}",
    "模式已自动清理，因此不会破坏工具调用：{0}",
    "스키마가 자동으로 정리되어 도구 호출을 방해하지 않음: {0}",
    "スキーマは自動的にサニタイズされ、ツール呼び出しを壊さないようになっています: {0}",
    "تم تطهير المخطط تلقائيًا بحيث لا يمكنه كسر استدعاء الأدوات: {0}",
    "Lo schema è stato auto-sanitizzato quindi non può rompere la chiamata agli strumenti: {0}"
  ],
  [
    "scope. Stored only on this device.",
    "范围。仅存储在此设备上。",
    "범위. 이 장치에만 저장됨.",
    "範囲。このデバイスのみに保存されます。",
    "النطاق. مخزن فقط على هذا الجهاز.",
    "ambito. Memorizzato solo su questo dispositivo."
  ],
  [
    "Screen capture is not available in this WebView.",
    "屏幕捕捉在此 WebView 中不可用。",
    "이 WebView에서는 화면 캡처를 사용할 수 없습니다.",
    "この WebView ではスクリーンキャプチャは利用できません。",
    "التقاط الشاشة غير متوفر في هذا العرض الويب.",
    "La cattura dello schermo non è disponibile in questa WebView."
  ],
  [
    "Screenshot a URL via headless Chromium (TwinForge web_adapter).",
    "通过无头 Chromium 截图 URL（TwinForge web_adapter）。",
    "헤드리스 크로미엄(TwinForge web_adapter)으로 URL 스크린샷.",
    "ヘッドレス Chromium（TwinForge web_adapter）を使用して URL のスクリーンショットを撮ります。",
    "التقاط لقطة شاشة لرابط عبر Chromium بدون واجهة (مُكيف TwinForge للويب).",
    "Acquisisci uno screenshot di un URL tramite Chromium senza interfaccia grafica (TwinForge web_adapter)."
  ],
  [
    "script/style removed, whitespace collapsed). Capped at 60 KB.",
    "删除脚本/样式，折叠空格). 限制为 60 KB。",
    "스크립트/스타일 제거, 공백 축소). 최대 60KB.",
    "script/style は削除され、空白は折りたたまれました）。60 KB で制限されています。",
    "تمت إزالة النصوص / الأنماط، وانهار الفراغ. الحد الأقصى 60 كيلوبايت.",
    "script/style rimossi, spazi bianchi compressi). Limite a 60 KB."
  ],
  [
    "scripts, etc.",
    "脚本等。",
    "스크립트 등.",
    "スクリプトなど。",
    "النصوص، إلخ.",
    "scripts, ecc."
  ],
  [
    "Search",
    "搜索",
    "검색",
    "検索",
    "بحث",
    "Cerca"
  ],
  [
    "Search {0} installed skills…",
    "搜索 {0} 已安装的技能…",
    "설치된 {0} 스킬 검색…",
    "インストールされているスキル {0} を検索…",
    "بحث في المهارات المثبتة {0}…",
    "Cerca le abilità installate di {0}…"
  ],
  [
    "Search assets…",
    "搜索资产…",
    "자산 검색…",
    "アセットを検索…",
    "بحث في الأصول…",
    "Cerca risorse…"
  ],
  [
    "Search by name, description, or path…",
    "按名称、描述或路径搜索…",
    "이름, 설명 또는 경로로 검색…",
    "名前、説明、またはパスで検索…",
    "البحث بالاسم أو الوصف أو المسار…",
    "Cerca per nome, descrizione o percorso…"
  ],
  [
    "Search Hugging Face…",
    "搜索 Hugging Face…",
    "허깅페이스 검색…",
    "Hugging Face を検索…",
    "بحث في Hugging Face…",
    "Cerca Hugging Face…"
  ],
  [
    "Search memory (keywords) — empty shows most recent",
    "搜索记忆（关键词）— 空白显示最近内容",
    "메모리 검색 (키워드) — 비어있으면 최신 항목 표시",
    "メモリを検索（キーワード）— 空の場合は最新を表示",
    "بحث في الذاكرة (الكلمات المفتاحية) — ترك الحقل فارغًا يعرض الأحدث",
    "Cerca nella memoria (parole chiave) — vuoto mostra le più recenti"
  ],
  [
    "Search query string.",
    "搜索查询字符串。",
    "쿼리 문자열 검색.",
    "クエリ文字列を検索。",
    "البحث عن سلسلة الاستعلام.",
    "Cerca stringa di query."
  ],
  [
    "Search the SHARED TEAM MEMORY — a durable knowledge base the whole team",
    "搜索共享团队记忆 — 一个全团队使用的持久知识库",
    "공유 팀 메모리 검색 — 전체 팀이 사용하는 지속 가능한 지식베이스",
    "SHARED TEAM MEMORY を検索 — チーム全員で使える耐久性のある知識ベース",
    "بحث في ذاكرة الفريق المشتركة — قاعدة معرفة دائمة للفريق بأكمله",
    "Cerca nella MEMORIA CONDIVISA DEL TEAM — una base di conoscenza duratura per tutto il team"
  ],
  [
    "Search the web. Returns up to 5 results (title, url, snippet).",
    "搜索网络。返回最多5个结果（标题，网址，摘要）。",
    "웹 검색. 최대 5개의 결과 반환 (제목, URL, 스니펫).",
    "ウェブを検索。最大5件の結果（タイトル、URL、スニペット）を返します。",
    "البحث على الويب. يُرجع حتى 5 نتائج (العنوان، الرابط، المقتطف).",
    "Cerca sul web. Restituisce fino a 5 risultati (titolo, URL, frammento)."
  ],
  [
    "Search…",
    "搜索…",
    "검색…",
    "検索…",
    "بحث…",
    "Cerca…"
  ],
  [
    "Second agent",
    "第二个代理",
    "두 번째 에이전트",
    "第二のエージェント",
    "الوكيل الثاني",
    "Secondo agente"
  ],
  [
    "Second agent — a parallel coder on the same workspace, with its own conversation and its own model (pick one above, or it uses the primary chat's model).",
    "第二代理 — 在同一工作区的并行编码器，具有自己的对话和自己的模型（在上面选择一个，或者它使用主聊天模型）。",
    "두 번째 에이전트 — 동일 작업 공간에서 병렬로 작동하는 코더로, 자체 대화와 자체 모델을 가짐 (위에서 하나 선택하거나 기본 채팅 모델 사용).",
    "第二のエージェント — 同じワークスペース上の並列コーダーで、独自の会話と独自のモデルを持ちます（上のいずれかを選択するか、プライマリチャットのモデルを使用します）。",
    "الوكيل الثاني — مبرمج متوازي في نفس مساحة العمل، له محادثته الخاصة ونموذجه الخاص (اختر أحد النماذج أعلاه، أو يستخدم نموذج الدردشة الأساسي).",
    "Secondo agente — un programmatore parallelo nello stesso spazio di lavoro, con la propria conversazione e il proprio modello (scegline uno sopra, oppure utilizza il modello della chat principale)."
  ],
  [
    "Second agent working in {0}",
    "第二个代理在 {0} 中工作",
    "두 번째 에이전트가 {0}에서 작업 중",
    "{0}で作業している2番目のエージェント",
    "الوكيل الثاني يعمل في {0}",
    "Secondo agente che lavora in {0}"
  ],
  [
    "secrets your",
    "你的秘密",
    "비밀 정보",
    "あなたの秘密",
    "أسرارك",
    "i tuoi segreti"
  ],
  [
    "Security",
    "安全",
    "보안",
    "セキュリティ",
    "الأمان",
    "Sicurezza"
  ],
  [
    "See everything you unlock with a free GitHub account",
    "查看使用免费 GitHub 账户可解锁的一切",
    "무료 GitHub 계정으로 잠금 해제한 모든 항목 보기",
    "無料のGitHubアカウントでアンロックしたすべてを確認",
    "شاهد كل شيء تفتحه بحساب GitHub مجاني",
    "Vedi tutto ciò che sblocchi con un account GitHub gratuito"
  ],
  [
    "see notices",
    "查看通知",
    "공지사항 보기",
    "通知を見る",
    "شاهد الإشعارات",
    "vedi avvisi"
  ],
  [
    "See OPENAI_COMPATIBLE_API.md for full instructions.",
    "请参阅 OPENAI_COMPATIBLE_API.md 获取完整说明。",
    "전체 지침은 OPENAI_COMPATIBLE_API.md를 참조하세요.",
    "完全な手順についてはOPENAI_COMPATIBLE_API.mdを参照",
    "راجع OPENAI_COMPATIBLE_API.md للتعليمات الكاملة.",
    "Vedi OPENAI_COMPATIBLE_API.md per le istruzioni complete."
  ],
  [
    "Seen channels:",
    "已查看的频道：",
    "본 채널 보기:",
    "閲覧したチャンネル:",
    "القنوات التي تمت مشاهدتها:",
    "Canali visti:"
  ],
  [
    "Seen chats:",
    "已查看的聊天：",
    "본 채팅 보기:",
    "閲覧したチャット:",
    "المحادثات التي تمت مشاهدتها:",
    "Chat viste:"
  ],
  [
    "Select a base model first (Base Model card above).",
    "首先选择一个基础模型（上面的基础模型卡）。",
    "먼저 기본 모델 선택(Base Model 카드 위 참조).",
    "最初にベースモデルを選択（上のベースモデルカード）。",
    "اختر نموذجًا أساسيًا أولاً (بطاقة النموذج الأساسي أعلاه).",
    "Seleziona prima un modello base (scheda Modello Base sopra)."
  ],
  [
    "Select a project…",
    "选择一个项目…",
    "프로젝트 선택…",
    "プロジェクトを選択…",
    "اختر مشروعًا…",
    "Seleziona un progetto…"
  ],
  [
    "Select all",
    "全选",
    "모두 선택",
    "すべて選択",
    "اختر الكل",
    "Seleziona tutto"
  ],
  [
    "Select all visible",
    "选择所有可见项",
    "보이는 모든 항목 선택",
    "表示されているものすべてを選択",
    "اختر كل العناصر المرئية",
    "Seleziona tutto ciò che è visibile"
  ],
  [
    "select an agent to equip",
    "选择一个代理以装备",
    "장착할 에이전트 선택",
    "装備するエージェントを選択",
    "اختر وكيلاً للتجهيز",
    "seleziona un agente da equipaggiare"
  ],
  [
    "Select an option (by value) in the <select> dropdown at the given index from the",
    "在给定索引的<select>下拉菜单中选择一个选项（按值）",
    "주어진 인덱스에서 <select> 드롭다운에서 옵션(값 기준) 선택",
    "指定されたインデックスの<select>ドロップダウンでオプション（値で）を選択",
    "اختر خيارًا (بالقيمة) من قائمة <select> المنسدلة عند الفهرس المعطى من",
    "Seleziona un'opzione (per valore) nel menu a tendina <select> all'indice indicato da"
  ],
  [
    "Select element index from the latest browser_snapshot.",
    "从最新的浏览器快照中选择元素索引。",
    "최신 browser_snapshot에서 요소 인덱스를 선택합니다.",
    "最新の browser_snapshot から要素のインデックスを選択します。",
    "حدد فهرس العنصر من أحدث لقطة للمتصفح.",
    "Seleziona l'indice dell'elemento dall'ultimo browser_snapshot."
  ],
  [
    "Select Model:",
    "选择模型：",
    "모델 선택:",
    "モデルを選択:",
    "حدد النموذج:",
    "Seleziona Modello:"
  ],
  [
    "Select none",
    "全不选",
    "없음 선택",
    "なしを選択",
    "حدد لا شيء",
    "Deseleziona tutto"
  ],
  [
    "Select safe",
    "选择安全",
    "안전 선택",
    "安全を選択",
    "حدد آمن",
    "Seleziona sicuro"
  ],
  [
    "Select Workspace Root",
    "选择工作区根目录",
    "워크스페이스 루트 선택",
    "ワークスペースのルートを選択",
    "حدد جذر مساحة العمل",
    "Seleziona la radice dell'area di lavoro"
  ],
  [
    "selected",
    "已选择",
    "선택됨",
    "選択済み",
    "تم التحديد",
    "selezionato"
  ],
  [
    "Selected — server will start when you pick model A.",
    "已选择 — 当你选择模型A时服务器将启动。",
    "선택됨 — 모델 A를 선택하면 서버가 시작됩니다.",
    "選択済み — モデル A を選択するとサーバーが起動します。",
    "تم التحديد — سيبدأ الخادم عند اختيارك للنموذج A.",
    "Selezionato — il server si avvierà quando scegli il modello A."
  ],
  [
    "selected ·",
    "已选择 ·",
    "선택됨 ·",
    "選択済み ·",
    "تم التحديد ·",
    "selezionato ·"
  ],
  [
    "Selected for inference — uncheck to skip this GPU",
    "为推理选择 — 取消勾选以跳过此GPU",
    "추론을 위해 선택됨 — 스킵하려면 이 GPU의 선택을 해제하세요",
    "推論用に選択済み — この GPU をスキップするにはチェックを外してください",
    "تم التحديد للاستدلال — قم بإلغاء التحديد لتخطي هذه وحدة معالجة الرسومات",
    "Selezionato per l'inferenza — deseleziona per ignorare questa GPU"
  ],
  [
    "Semantic search — better than keyword for research/fact-finding.",
    "语义搜索 — 比关键字更适合研究/事实查找。",
    "의미 기반 검색 — 연구/사실 찾기에 키워드보다 더 좋습니다.",
    "セマンティック検索 — リサーチや事実確認にはキーワード検索より優れています。",
    "البحث الدلالي — أفضل من الكلمات المفتاحية للبحث/اكتشاف الحقائق.",
    "Ricerca semantica — migliore delle parole chiave per ricerca/trovare fatti."
  ],
  [
    "Send",
    "发送",
    "전송",
    "送信",
    "إرسال",
    "Invia"
  ],
  [
    "Send a message below — this column will reply.",
    "在下方发送消息 — 此列将回复。",
    "아래에 메시지를 보내세요 — 이 열이 답변합니다.",
    "以下にメッセージを送信 — この列が応答します。",
    "أرسل رسالة أدناه — هذا العمود سيرد.",
    "Invia un messaggio qui sotto — questa colonna risponderà."
  ],
  [
    "Send message",
    "发送消息",
    "메시지 보내기",
    "メッセージを送信",
    "إرسال رسالة",
    "Invia messaggio"
  ],
  [
    "Send this device a pairing request (it must approve you)",
    "向此设备发送配对请求（它必须批准你）",
    "이 장치에 페어링 요청을 보내세요 (장치가 승인을 해야 합니다.)",
    "このデバイスにペアリングリクエストを送信（承認が必要です）",
    "أرسل لهذا الجهاز طلب اقتران (يجب أن يوافق عليك)",
    "Invia a questo dispositivo una richiesta di accoppiamento (deve approvarti)"
  ],
  [
    "Send to the second agent",
    "发送给第二个代理",
    "두 번째 에이전트에게 보내기",
    "第2のエージェントに送信",
    "أرسل إلى الوكيل الثاني",
    "Invia al secondo agente"
  ],
  [
    "Send your description + this view + diagnostics + any screenshot to the OwLLM team.",
    "将你的描述 + 此视图 + 诊断信息 + 任何截图发送给 OwLLM 团队。",
    "설명 + 이 뷰 + 진단 + 스크린샷을 OwLLM 팀에 보내세요.",
    "あなたの説明 + このビュー + 診断情報 + 任意のスクリーンショットをOwLLMチームに送信してください。",
    "أرسل وصفك + هذا العرض + التشخيصات + أي لقطة شاشة إلى فريق OwLLM.",
    "Invia la tua descrizione + questa vista + diagnostica + eventuale screenshot al team OwLLM."
  ],
  [
    "sent",
    "已发送",
    "전송됨",
    "送信済み",
    "تم الإرسال",
    "inviato"
  ],
  [
    "Sentry internal integration token. Settings → Developer Settings → Internal Integrations.",
    "Sentry 内部集成令牌。设置 → 开发者设置 → 内部集成。",
    "Sentry 내부 통합 토큰. 설정 → 개발자 설정 → 내부 통합.",
    "Sentry内部統合トークン。設定 → 開発者設定 → 内部統合。",
    "رمز تكامل داخلي لـ Sentry. الإعدادات → إعدادات المطور → التكاملات الداخلية.",
    "Token di integrazione interna di Sentry. Impostazioni → Impostazioni sviluppatore → Integrazioni interne."
  ],
  [
    "Sentry issues — list, drill into stacktraces, recent events.",
    "Sentry 问题 — 列表，深入堆栈跟踪，最近事件。",
    "Sentry 문제 — 목록, 스택트레이스 탐색, 최근 이벤트.",
    "Sentryの問題 — リスト、スタックトレースの詳細、最近のイベント。",
    "مشاكل Sentry — القائمة، الغوص في تتبع المكدس، الأحداث الأخيرة.",
    "Sentry problemi — elenco, approfondire gli stack trace, eventi recenti."
  ],
  [
    "Server",
    "服务器",
    "서버",
    "サーバー",
    "الخادم",
    "Server"
  ],
  [
    "Server Core",
    "服务器核心",
    "서버 코어",
    "サーバーコア",
    "نواة الخادم",
    "Core del server"
  ],
  [
    "Server log",
    "服务器日志",
    "서버 로그",
    "サーバーログ",
    "سجل الخادم",
    "Registro del server"
  ],
  [
    "Server logs will appear here.",
    "服务器日志将显示在此处。",
    "서버 로그가 여기에 표시됩니다.",
    "サーバーログはここに表示されます。",
    "ستظهر سجلات الخادم هنا.",
    "I registri del server appariranno qui."
  ],
  [
    "serving",
    "服务中",
    "제공 중",
    "提供中",
    "خدمة",
    "servendo"
  ],
  [
    "session; localhost URLs default to http). Call browser_snapshot afterward",
    "会话；本地主机 URL 默认为 http)。之后调用 browser_snapshot",
    "세션; 로컬호스트 URL 기본값은 http입니다). 이후 browser_snapshot 호출",
    "session; localhostのURLはデフォルトでhttpです。後でbrowser_snapshotを呼び出してください",
    "الجلسة؛ عناوين URL المحلية الافتراضية على http). استدعِ browser_snapshot بعد ذلك",
    "sessione; gli URL localhost predefiniti a http). Chiama browser_snapshot successivamente"
  ],
  [
    "set",
    "设置",
    "설정",
    "設定",
    "اضبط",
    "Imposta"
  ],
  [
    "Set",
    "设置",
    "세트",
    "セット",
    "مجموعة",
    "Set"
  ],
  [
    "Set a certificate to Authenticode-sign the release .exe/installer and clear SmartScreen \"unknown publisher\". Leave both empty to ship unsigned. The cert must be installed on the machine that runs Publish (e.g. SimplySign/Certum cloud card, a PFX, or an HSM).",
    "设置证书以对发布的 .exe/安装程序进行 Authenticode 签名，并清除 SmartScreen 上的“未知发布者”提示。两者都留空则发布未签名版本。证书必须安装在运行 Publish 的机器上（例如：SimplySign/Certum 云卡、PFX 或 HSM）。",
    "릴리스 .exe/인스톨러를 Authenticode 서명하기 위해 인증서를 설정하고 SmartScreen의 \"알 수 없는 게시자\"를 제거합니다. 둘 다 비워두면 서명되지 않은 상태로 배포됩니다. 인증서는 Publish를 실행하는 컴퓨터에 설치되어 있어야 합니다(예: SimplySign/Certum 클라우드 카드, PFX, 또는 HSM).",
    "リリースの .exe/インストーラーに Authenticode 署名するための証明書を設定し、SmartScreen の「不明な発行元」をクリアします。署名せずに出荷する場合は両方を空のままにしてください。証明書は Publish を実行するマシンにインストールされている必要があります（例：SimplySign/Certum クラウドカード、PFX、または HSM）。",
    "اضبط شهادة لتوقيع الإصدار .exe/المثبت باستخدام Authenticode وإزالة \"ناشر غير معروف\" من SmartScreen. اترك كلا الحقلين فارغين للإصدار غير الموقع. يجب تثبيت الشهادة على الجهاز الذي يشغّل النشر (مثل بطاقة SimplySign/Certum السحابية، PFX، أو HSM).",
    "Imposta un certificato per firmare Authenticode il rilascio .exe/installer e rimuovere \"editore sconosciuto\" da SmartScreen. Lascia entrambi vuoti per distribuire senza firma. Il certificato deve essere installato sulla macchina che esegue Publish (ad es. SimplySign/Certum cloud card, un PFX o un HSM)."
  ],
  [
    "Set key",
    "设置键",
    "키 설정",
    "キーを設定",
    "تعيين المفتاح",
    "Imposta chiave"
  ],
  [
    "Set the webhook URL in the LINE Developers console to",
    "在 LINE Developers 控制台中设置 webhook URL 为",
    "LINE Developers 콘솔에서 웹훅 URL 설정",
    "LINE Developers コンソールで webhook URL を設定",
    "اضبط عنوان URL للويب هوك في وحدة تحكم LINE Developers إلى",
    "Imposta l'URL del webhook nella console di LINE Developers su"
  ],
  [
    "set up a signed + notarized release in ANY project. Returns status/metadata (identity, team id,",
    "在任何项目中设置签署的+公证的发布。返回状态/元数据（身份，团队ID，",
    "어떤 프로젝트에서든 서명 및 공인된 릴리스를 설정합니다. 상태/메타데이터(신원, 팀 ID 등)를 반환합니다.",
    "任意のプロジェクトで署名済み + 公証済みリリースを設定します。ステータス/メタデータ（ID、チームID）を返します",
    "إعداد إصدار موقع + موثق في أي مشروع. يعيد الحالة/بيانات التعريف (الهوية، معرف الفريق،",
    "configurare un rilascio firmato + notarizzato in QUALSIASI progetto. Restituisce stato/metadati (identità, ID team,"
  ],
  [
    "settings",
    "设置",
    "설정",
    "設定",
    "الإعدادات",
    "impostazioni"
  ],
  [
    "Shared knowledge your agents read & write",
    "共享知识，您的代理可以读取和写入",
    "공유 지식은 에이전트가 읽고 씁니다",
    "あなたのエージェントが読み書きする共有知識",
    "المعرفة المشتركة التي يقرأها و يكتبها عملاؤك",
    "Conoscenza condivisa che i tuoi agenti leggono e scrivono"
  ],
  [
    "Shared secret external clients must send as X-Auth-Token.",
    "外部客户端必须通过 X-Auth-Token 发送的共享密钥。",
    "외부 클라이언트가 X-Auth-Token으로 보내야 하는 공유 비밀",
    "外部クライアントが X-Auth-Token として送信する必要がある共有シークレット",
    "السر المشترك الذي يجب على العملاء الخارجيين إرساله كـ X-Auth-Token.",
    "Segreto condiviso che i clienti esterni devono inviare come X-Auth-Token."
  ],
  [
    "shared with team",
    "与团队共享",
    "팀과 공유됨",
    "チームと共有",
    "مشترك مع الفريق",
    "condiviso con il team"
  ],
  [
    "shell",
    "Shell",
    "쉘",
    "シェル",
    "شل",
    "Shell"
  ],
  [
    "Shell",
    "壳",
    "껍질",
    "シェル",
    "صدفة",
    "Conchiglia"
  ],
  [
    "Shell commands",
    "Shell 命令",
    "셸 명령어",
    "シェルコマンド",
    "أوامر الشل",
    "Comandi della shell"
  ],
  [
    "Ship it — GitHub Actions secrets",
    "发布它 — GitHub Actions 密钥",
    "배포 — GitHub Actions 비밀",
    "出荷 — GitHub Actionsのシークレット",
    "عرضه — أسرار GitHub Actions",
    "Spedisci — Segreti di GitHub Actions"
  ],
  [
    "Show",
    "显示",
    "보기",
    "表示",
    "عرض",
    "Mostra"
  ],
  [
    "Show a second, independent agent chat pane beside this one — its own transcript and input, same workspace and model.",
    "在此旁边显示第二个独立的代理聊天窗格 — 它自己的对话记录和输入，相同的工作区和模型。",
    "이 채팅 옆에 두 번째 독립적인 에이전트 채팅 창을 표시 — 고유한 전사 및 입력, 동일한 작업 공간과 모델.",
    "この横に、第二の独立したエージェントチャットペインを表示 — 独自のトランスクリプトと入力、同じワークスペースとモデル",
    "عرض نافذة محادثة وكيل ثاني مستقل بجانب هذه — سجل المحادثة والمدخلات الخاصة به، نفس مساحة العمل والنموذج.",
    "Mostra un secondo riquadro di chat agente indipendente accanto a questo — la sua trascrizione e input separati, stesso spazio di lavoro e modello."
  ],
  [
    "Show log",
    "显示日志",
    "로그 보기",
    "ログを表示",
    "عرض السجل",
    "Mostra registro"
  ],
  [
    "Show or hide completed steps",
    "显示或隐藏已完成的步骤",
    "완료된 단계 표시 또는 숨기기",
    "完了したステップを表示または非表示",
    "عرض أو إخفاء الخطوات المكتملة",
    "Mostra o nascondi passaggi completati"
  ],
  [
    "Show or hide the raw digest transcript",
    "显示或隐藏原始摘要记录",
    "원시 다이제스트 전사 표시 또는 숨기기",
    "生のダイジェストトランスクリプトを表示または非表示",
    "عرض أو إخفاء نص الملخص الخام",
    "Mostra o nascondi la trascrizione grezza del digest"
  ],
  [
    "Show readiness checks",
    "显示准备检查",
    "준비 상태 확인 표시",
    "準備状況チェックを表示",
    "عرض فحوصات الجاهزية",
    "Mostra i controlli di prontezza"
  ],
  [
    "Show the Full Chat tab",
    "显示完整聊天标签",
    "전체 채팅 탭 표시",
    "フルチャットタブを表示",
    "عرض تبويب الدردشة الكاملة",
    "Mostra la scheda Chat completa"
  ],
  [
    "Show the Thought tab",
    "显示思考标签",
    "사고 탭 표시",
    "思考タブを表示",
    "عرض تبويب الأفكار",
    "Mostra la scheda Pensiero"
  ],
  [
    "Show the Tool Calls tab",
    "显示工具调用标签",
    "도구 호출 탭 표시",
    "ツールコールタブを表示",
    "عرض تبويب استدعاءات الأدوات",
    "Mostra la scheda Chiamate agli strumenti"
  ],
  [
    "Show the User Input history",
    "显示用户输入历史",
    "사용자 입력 기록 표시",
    "ユーザー入力履歴を表示",
    "عرض سجل مدخلات المستخدم",
    "Mostra la cronologia input utente"
  ],
  [
    "Show tools",
    "显示工具",
    "도구 표시",
    "ツールを表示",
    "عرض الأدوات",
    "Mostra strumenti"
  ],
  [
    "Show window",
    "显示窗口",
    "창 표시",
    "ウィンドウを表示",
    "عرض النافذة",
    "Mostra finestra"
  ],
  [
    "Sign in →",
    "登录 →",
    "로그인 →",
    "サインイン →",
    "تسجيل الدخول →",
    "Accedi →"
  ],
  [
    "Sign in to sync your chats & settings across devices",
    "登录以在设备间同步您的聊天和设置",
    "채팅 및 설정을 기기 간에 동기화하려면 로그인하세요",
    "チャットと設定を複数のデバイスで同期するにはサインインしてください",
    "تسجيل الدخول لمزامنة محادثاتك وإعداداتك عبر الأجهزة",
    "Accedi per sincronizzare le tue chat e impostazioni su tutti i dispositivi"
  ],
  [
    "Sign in with GitHub",
    "使用 GitHub 登录",
    "GitHub로 로그인",
    "GitHubでサインイン",
    "تسجيل الدخول باستخدام GitHub",
    "Accedi con GitHub"
  ],
  [
    "Sign up with email, no card. Built for AI agents — cleaner results than vanilla web search.",
    "使用电子邮件注册，无需信用卡。为 AI 代理构建——比普通网络搜索结果更干净。",
    "이메일로 가입, 카드 필요 없음. AI 에이전트를 위해 제작 — 일반 웹 검색보다 더 깔끔한 결과 제공.",
    "メールでサインアップ、カード不要。AIエージェント向け — 通常のウェブ検索よりもきれいな結果。",
    "التسجيل باستخدام البريد الإلكتروني، بدون بطاقة. مصمم لوكلاء الذكاء الاصطناعي — نتائج أنظف من البحث على الويب التقليدي.",
    "Iscriviti con l'email, senza carta. Creato per agenti AI — risultati più puliti rispetto alla ricerca web tradizionale."
  ],
  [
    "Signed",
    "已签名",
    "서명됨",
    "署名済み",
    "تم التوقيع",
    "Firmato"
  ],
  [
    "SimplySign not running",
    "SimplySign 未运行",
    "SimplySign 실행 중 아님",
    "SimplySignは実行されていません",
    "SimplySign غير قيد التشغيل",
    "SimplySign non in esecuzione"
  ],
  [
    "SimplySign running",
    "SimplySign 正在运行",
    "SimplySign 실행 중",
    "SimplySign実行中",
    "SimplySign قيد التشغيل",
    "SimplySign in esecuzione"
  ],
  [
    "Simulate a pairing request (v1 loopback) to drive the approve→control flow",
    "模拟配对请求（v1 回环）以驱动批准→控制流程",
    "승인→제어 흐름을 진행하기 위해 페어링 요청(v1 루프백) 시뮬레이션",
    "承認→制御のフローを駆動するためにペアリングリクエスト（v1ループバック）をシミュレート",
    "محاكاة طلب اقتران (v1 loopback) لتوجيه تدفق الموافقة → التحكم",
    "Simula una richiesta di accoppiamento (loopback v1) per guidare il flusso approva→controlla"
  ],
  [
    "single source for digest",
    "单一来源用于摘要",
    "다이제스트의 단일 소스",
    "ダイジェストの単一ソース",
    "مصدر واحد للتلخيص",
    "fonte singola per digest"
  ],
  [
    "site (e.g. developer.apple.com)",
    "网站（例如 developer.apple.com）",
    "사이트 (예: developer.apple.com)",
    "サイト（例: developer.apple.com）",
    "الموقع (مثل developer.apple.com)",
    "sito (es. developer.apple.com)"
  ],
  [
    "site (e.g. github.com)",
    "网站（例如 github.com）",
    "사이트 (예: github.com)",
    "サイト（例: github.com）",
    "الموقع (مثل github.com)",
    "sito (es. github.com)"
  ],
  [
    "Size",
    "大小",
    "크기",
    "サイズ",
    "الحجم",
    "Dimensione"
  ],
  [
    "SKILL",
    "技能",
    "기술",
    "スキル",
    "المهارة",
    "ABILITÀ"
  ],
  [
    "SKILL PACK · ~",
    "技能包 · ~",
    "기술 팩 · ~",
    "スキルパック · ~",
    "حزمة المهارات · ~",
    "PACCHETTO DI COMPETENZE · ~"
  ],
  [
    "Skill packs are managed in the 📚 Skill Library — open it to remove this one.",
    "技能包在📚 技能库中管理——打开它以移除此包。",
    "스킬 팩은 📚 스킬 라이브러리에서 관리됩니다 — 이 스킬을 제거하려면 열어보세요.",
    "スキルパックは📚 スキルライブラリで管理されています — 開いてこれを削除してください。",
    "تُدار حزم المهارات في 📚 مكتبة المهارات — افتحها لإزالة هذه.",
    "I pacchetti di abilità sono gestiti nella 📚 Libreria delle Abilità — aprila per rimuovere questo."
  ],
  [
    "skills",
    "技能",
    "스킬",
    "スキル",
    "المهارات",
    "abilità"
  ],
  [
    "Skills (",
    "技能（",
    "스킬 (",
    "スキル (",
    "المهارات (",
    "Abilità ("
  ],
  [
    "Skills are named capability guides bundled with the app. Use this to",
    "技能是与应用捆绑的命名能力指南。使用它来",
    "스킬은 앱과 함께 번들로 제공되는 명명된 능력 가이드입니다. 이를 사용하려면",
    "スキルはアプリにバンドルされた能力ガイドです。これを使って",
    "المهارات هي دليل القدرات المسماة المدمجة مع التطبيق. استخدم هذا ل",
    "Le abilità sono guide di capacità denominate raggruppate con l'app. Usale per"
  ],
  [
    "Skills are SKILL.md capability packs (Anthropic-style). They're NOT agents — you equip a skill onto an agent (in a Team's Workbench, or per-agent on the Agents page) and the runtime loads it only when a task needs it. Install more from the library.",
    "技能是 SKILL.md 功能包（Anthropic 风格）。它们不是代理——你可以将技能装备到代理上（在团队的工作台上，或在代理页面上为每个代理装备），运行时只有在任务需要时才会加载它。可从库中安装更多。",
    "스킬은 SKILL.md 능력 팩(Anthropic 스타일)입니다. 스킬은 에이전트가 아니며 — 스킬을 에이전트에 장착하면(팀 작업대에서 혹은 에이전트 페이지에서 에이전트별로) 실행 시간에 해당 작업이 필요할 때만 로드됩니다. 라이브러리에서 더 설치할 수 있습니다.",
    "スキルはSKILL.md能力パック（Anthropicスタイル）です。エージェントではありません — スキルをエージェントに装備し（チームのワークベンチで、またはエージェントページで個別に）、ランタイムはタスクが必要なときのみロードします。ライブラリからさらにインストールできます。",
    "المهارات هي حزم قدرات SKILL.md (على طريقة Anthropic). إنها ليست وكلاء — تقوم بتزويد وكيل بمهارة (في ورشة عمل الفريق، أو لكل وكيل في صفحة الوكلاء) ويتم تحميلها أثناء التشغيل فقط عند الحاجة لمهمة. قم بتثبيت المزيد من المكتبة.",
    "Le abilità sono pacchetti di capacità SKILL.md (stile Anthropic). NON sono agenti — si equipaggia un'abilità su un agente (nel Banco di Lavoro di un Team o per agente nella pagina Agenti) e il runtime la carica solo quando un compito lo richiede. Installa di più dalla libreria."
  ],
  [
    "skills equipped",
    "已装备技能",
    "장착된 스킬",
    "装備済みスキル",
    "المهارات المجهزة",
    "abilità equipaggiate"
  ],
  [
    "Skills: {0}",
    "技能：{0}",
    "스킬: {0}",
    "スキル: {0}",
    "المهارات: {0}",
    "Abilità: {0}"
  ],
  [
    "Skip — use cloud models only",
    "跳过——仅使用云模型",
    "건너뛰기 — 클라우드 모델만 사용",
    "スキップ — クラウドモデルのみ使用",
    "تخطي — استخدام نماذج السحابة فقط",
    "Salta — usa solo modelli cloud"
  ],
  [
    "Slack",
    "Slack",
    "슬랙",
    "Slack",
    "Slack",
    "Slack"
  ],
  [
    "Slack workspace API — messages, channels, search.",
    "Slack 工作区 API——消息、频道、搜索。",
    "슬랙 워크스페이스 API — 메시지, 채널, 검색.",
    "SlackワークスペースAPI — メッセージ、チャンネル、検索",
    "واجهة برمجة تطبيقات مساحة العمل في Slack — الرسائل، القنوات، البحث.",
    "API dello spazio di lavoro Slack — messaggi, canali, ricerca."
  ],
  [
    "Slash commands",
    "斜杠命令",
    "슬래시 명령어",
    "スラッシュコマンド",
    "أوامر الشرط المائل",
    "Comandi slash"
  ],
  [
    "Slate",
    "Slate",
    "슬레이트",
    "スレート",
    "سلِيت",
    "Ardesia"
  ],
  [
    "smtp.gmail.com",
    "smtp.gmail.com",
    "smtp.gmail.com",
    "smtp.gmail.com",
    "smtp.gmail.com",
    "smtp.gmail.com"
  ],
  [
    "Snapshot first to get the index; the page may change, so snapshot again after.",
    "先快照以获取索引；页面可能会更改，因此之后需要再次快照。",
    "먼저 스냅샷을 찍어 인덱스를 얻으세요; 페이지가 바뀔 수 있으므로 나중에 다시 스냅샷을 찍으세요.",
    "まずスナップショットを取得してインデックスを作成してください。ページは変更される可能性があるので、あとで再度スナップショットを取ります。",
    "التقط لقطة أولاً للحصول على الفهرس؛ قد تتغير الصفحة، لذا التقط لقطة مرة أخرى بعد ذلك.",
    "Scatta prima un'istantanea per ottenere l'indice; la pagina potrebbe cambiare, quindi scatta di nuovo l'istantanea dopo."
  ],
  [
    "Snapshot the current page and return the INDEXED list of interactive elements",
    "快照当前页面并返回已索引的交互元素列表",
    "현재 페이지를 스냅샷하고 대화형 요소의 인덱스된 목록을 반환하세요",
    "現在のページをスナップショットし、インデックス化された対話型要素のリストを返してください",
    "التقط لقطة للصفحة الحالية واعرض قائمة العناصر التفاعلية المفهرسة",
    "Scatta l'istantanea della pagina corrente e restituisci l'elenco INDICIZZATO degli elementi interattivi"
  ],
  [
    "sntrys_…",
    "sntrys_…",
    "sntrys_…",
    "sntrys_…",
    "sntrys_…",
    "sntrys_…"
  ],
  [
    "so Windows can turn on the Virtual Machine Platform, then come back here. We create the Linux user for you afterwards — you won't see a confusing Ubuntu console.",
    "这样 Windows 就可以启用虚拟机平台，然后回到这里。之后我们会为你创建 Linux 用户——你不会看到令人困惑的 Ubuntu 控制台。",
    "Windows에서 가상 머신 플랫폼을 켤 수 있도록 한 후 여기에 다시 돌아오세요. 그 후에 Linux 사용자를 만들어 드리겠습니다 — 혼란스러운 Ubuntu 콘솔을 볼 필요가 없습니다.",
    "Windowsが仮想マシンプラットフォームをオンにできるようにし、その後ここに戻ってきてください。その後、Linuxユーザーを作成します — 混乱するUbuntuコンソールは表示されません。",
    "حتى يتمكن ويندوز من تشغيل منصة الآلة الافتراضية، ثم عد إلى هنا. سنقوم بإنشاء مستخدم Linux لك بعد ذلك — لن ترى وحدة تحكم Ubuntu المربكة.",
    "così Windows può attivare la Piattaforma Macchina Virtuale, poi torna qui. Creiamo l'utente Linux per te in seguito — non vedrai una console Ubuntu confusa."
  ],
  [
    "Social media",
    "社交媒体",
    "소셜 미디어",
    "ソーシャルメディア",
    "وسائل التواصل الاجتماعي",
    "Social media"
  ],
  [
    "Socket Mode",
    "Socket 模式",
    "소켓 모드",
    "ソケットモード",
    "وضع المقابس",
    "Modalità Socket"
  ],
  [
    "Socket Mode · app + bot token · no public URL needed",
    "Socket 模式 · 应用 + 机器人令牌 · 不需要公共 URL",
    "소켓 모드 · 앱 + 봇 토큰 · 공개 URL 필요 없음",
    "ソケットモード · アプリ + ボットトークン · 公開URL不要",
    "وضع المقابس · التطبيق + رمز البوت · لا حاجة إلى URL عام",
    "Modalità Socket · app + token bot · nessun URL pubblico necessario"
  ],
  [
    "Software / tool",
    "软件 / 工具",
    "소프트웨어 / 도구",
    "ソフトウェア / ツール",
    "البرمجيات / الأداة",
    "Software / strumento"
  ],
  [
    "Solo-Loop",
    "单人循环",
    "솔로-루프",
    "ソロループ",
    "حلقة فردية",
    "Solo-Loop"
  ],
  [
    "Solo-Loop — one coder does the whole job, a single critic check, rule-based publish",
    "单人循环——一个程序员完成整个工作，一个评论者检查，基于规则发布",
    "솔로-루프 — 한 명의 코더가 전체 작업을 수행하고, 한 명의 검토자가 확인하며, 규칙 기반으로 게시",
    "ソロループ — 一人のコーダーが全ての作業を行い、一人の批評家がチェックし、ルールに基づいて公開",
    "حلقة مفردة — يقوم مبرمج واحد بالعمل كله، فحص واحد من قِبل ناقد، نشر قائم على القواعد",
    "Solo-Loop — un programmatore fa tutto il lavoro, un singolo controllo del critico, pubblicazione basata su regole"
  ],
  [
    "something that may already be known. Returns the most relevant entries.",
    "可能已经知道的内容。返回最相关的条目。",
    "이미 알려져 있을 수 있는 것. 가장 관련성 높은 항목을 반환합니다.",
    "すでに知られているかもしれないもの。最も関連性の高いエントリを返す。",
    "شيء قد يكون معروفًا بالفعل. يُرجع أهم الإدخالات.",
    "qualcosa che potrebbe già essere noto. Restituisce le voci più rilevanti."
  ],
  [
    "Sort by",
    "排序方式",
    "정렬 기준",
    "並べ替え",
    "الترتيب حسب",
    "Ordina per"
  ],
  [
    "Source",
    "来源",
    "출처",
    "ソース",
    "المصدر",
    "Fonte"
  ],
  [
    "SOURCES (",
    "来源（",
    "출처 (",
    "ソース（",
    "المصادر (",
    "FONTI ("
  ],
  [
    "Speak agent replies aloud — voice per agent. Click ▾ to switch engine.",
    "语音代理大声回复——每个代理有自己的声音。点击 ▾ 切换引擎。",
    "대화 에이전트가 대답을 음성으로 읽음 — 에이전트별 음성. 엔진을 변경하려면 ▾ 클릭.",
    "エージェントの返信を声に出して話す — エージェントごとに声。エンジンを切り替えるには ▾ をクリック。",
    "ردود وكيل التحدث بصوت عالٍ — صوت لكل وكيل. انقر ▾ لتغيير المحرك.",
    "L'agente parlante risponde ad alta voce — voce per agente. Clicca ▾ per cambiare motore."
  ],
  [
    "Speak this agent's replies aloud",
    "大声朗读此代理的回复",
    "이 에이전트의 답변을 음성으로 읽기",
    "このエージェントの返信を声に出して話す",
    "تحدث ردود هذا الوكيل بصوت عالٍ",
    "Fai parlare ad alta voce le risposte di questo agente"
  ],
  [
    "Speaking rate (words per minute, 0 = default)",
    "语速（每分钟单词数，0 = 默认）",
    "발화 속도 (단어/분, 0 = 기본)",
    "話す速さ（1分あたりの単語数、0 = デフォルト）",
    "معدل الكلام (كلمات في الدقيقة، 0 = الافتراضي)",
    "Velocità di parola (parole al minuto, 0 = predefinito)"
  ],
  [
    "Speed",
    "速度",
    "속도",
    "速度",
    "السرعة",
    "Velocità"
  ],
  [
    "Split the prompt text into Mission / Rules / Definition of Done using this agent's model. Categorises only — keeps your wording. Review, then Save.",
    "使用该代理的模型将提示文本拆分为任务 / 规则 / 完成定义。仅进行分类——保持你的措辞。审查，然后保存。",
    "프롬프트 텍스트를 이 에이전트의 모델을 사용하여 Mission / Rules / Definition of Done으로 나누세요. 분류만 하며 — 표현은 그대로 유지합니다. 검토 후 저장하세요.",
    "プロンプトテキストを、このエージェントのモデルを使って、Mission / Rules / Definition of Done に分割します。分類のみ — あなたの言葉を保ちます。確認して、保存してください。",
    "قسّم نص المطالبة إلى المهمة / القواعد / تعريف الانتهاء باستخدام نموذج هذا الوكيل. يصنّف فقط — يحافظ على صياغتك. راجع، ثم احفظ.",
    "Dividi il testo del prompt in Missione / Regole / Definizione di Completamento usando il modello di questo agente. Classifica soltanto — mantieni le tue parole. Rivedi, poi Salva."
  ],
  [
    "SSH keys (no passwords). Returns stdout/stderr/exit_code. Use to operate,",
    "SSH 密钥（不含密码）。返回 stdout/stderr/退出码。用于操作，",
    "SSH 키 (비밀번호 없음). stdout/stderr/exit_code를 반환합니다. 운영에 사용하세요.",
    "SSHキー（パスワードなし）。stdout/stderr/exit_codeを返します。操作に使用してください。",
    "مفاتيح SSH (بدون كلمات مرور). يُرجع stdout/stderr/exit_code. استخدمه للتشغيل،",
    "Chiavi SSH (nessuna password). Restituisce stdout/stderr/codice_di_uscita. Usalo per operare,"
  ],
  [
    "SSH port (default 22).",
    "SSH 端口（默认 22）。",
    "SSH 포트 (기본값 22).",
    "SSHポート（デフォルト22）。",
    "منفذ SSH (الافتراضي 22).",
    "Porta SSH (predefinita 22)."
  ],
  [
    "SSH username (omit to use ssh config / current user).",
    "SSH 用户名（省略以使用 ssh 配置 / 当前用户）。",
    "SSH 사용자 이름 (ssh 구성 / 현재 사용자 사용 시 생략).",
    "SSHユーザー名（ssh設定／現在のユーザーを使用する場合は省略）。",
    "اسم مستخدم SSH (تجاوز لإستخدام إعدادات ssh / المستخدم الحالي).",
    "Nome utente SSH (ometti per usare la configurazione ssh / utente corrente)."
  ],
  [
    "SSH username.",
    "SSH 用户名。",
    "SSH 사용자 이름.",
    "SSHユーザー名。",
    "اسم مستخدم SSH.",
    "Nome utente SSH."
  ],
  [
    "Stage path",
    "阶段路径",
    "단계 경로",
    "ステージパス",
    "مسار المرحلة",
    "Percorso di fase"
  ],
  [
    "Standard",
    "标准",
    "표준",
    "標準",
    "قياسي",
    "Standard"
  ],
  [
    "Start",
    "开始",
    "시작",
    "開始",
    "ابدأ",
    "Avvia"
  ],
  [
    "start {0}: {1}",
    "开始 {0}：{1}",
    "시작 {0}: {1}",
    "start {0}: {1}",
    "ابدأ {0}: {1}",
    "avvia {0}: {1}"
  ],
  [
    "Start a training run from the Train tab to produce a LoRA adapter.",
    "从训练标签页启动训练运行以生成 LoRA 适配器。",
    "LoRA 어댑터를 생성하기 위해 Train 탭에서 학습 실행을 시작하세요.",
    "Trainタブからトレーニングを開始して、LoRAアダプターを生成します。",
    "ابدأ تشغيل التدريب من علامة التبويب Train لإنتاج موائم LoRA.",
    "Avvia una sessione di addestramento dalla scheda Train per produrre un adattatore LoRA."
  ],
  [
    "Start dictation (Web Speech)",
    "开始听写（Web Speech）",
    "음성 인식 시작 (웹 음성)",
    "ディクテーション開始（Web Speech）",
    "ابدأ الإملاء (Web Speech)",
    "Avvia dettatura (Web Speech)"
  ],
  [
    "Start failed: {0}",
    "启动失败：{0}",
    "시작 실패: {0}",
    "開始に失敗しました: {0}",
    "فشل البدء: {0}",
    "Avvio fallito: {0}"
  ],
  [
    "Start the whole NOW batch as a new goal. The board keeps its cards.",
    "将整个 NOW 批处理作为新目标开始。棋盘保留其卡片。",
    "전체 NOW 배치를 새로운 목표로 시작합니다. 보드는 자신의 카드를 유지합니다.",
    "今すぐバッチ全体を新しい目標として開始します。ボードはそのカードを保持します。",
    "ابدأ الدفعة الكاملة الآن كهدف جديد. يحتفظ اللوح ببطاقاته.",
    "Avvia l'intero lotto ORA come nuovo obiettivo. La scheda mantiene le sue carte."
  ],
  [
    "started {0} • finished {1} • {2}",
    "开始 {0} • 完成 {1} • {2}",
    "시작 {0} • 완료 {1} • {2}",
    "開始 {0} • 終了 {1} • {2}",
    "بدأ {0} • انتهى {1} • {2}",
    "iniziato {0} • finito {1} • {2}"
  ],
  [
    "started {0} • running {1}",
    "开始 {0} • 运行 {1}",
    "{0} 시작됨 • {1} 실행 중",
    "開始しました {0} • 実行中 {1}",
    "بدأ {0} • جاري {1}",
    "iniziato {0} • in esecuzione {1}"
  ],
  [
    "starting",
    "开始",
    "시작",
    "開始",
    "بدء",
    "avvio"
  ],
  [
    "Starting — binding the shared webhook listener.",
    "启动 — 绑定共享的 webhook 监听器。",
    "시작 — 공유 웹훅 리스너 바인딩 중.",
    "開始 — 共有ウェブフックリスナーをバインド中。",
    "بدء — ربط مستمع الويب هوك المشترك.",
    "Avvio — collegamento del listener webhook condiviso."
  ],
  [
    "Starting — binding the webhook listener.",
    "启动 — 绑定 webhook 监听器。",
    "시작 — 웹훅 리스너 바인딩 중.",
    "開始 — ウェブフックリスナーをバインド中。",
    "بدء — ربط مستمع الويب هوك.",
    "Avvio — collegamento del listener webhook."
  ],
  [
    "Starting — connecting to IMAP.",
    "启动 — 连接到 IMAP。",
    "시작 — IMAP에 연결 중.",
    "開始 — IMAP に接続中。",
    "بدء — الاتصال بـ IMAP.",
    "Avvio — connessione a IMAP."
  ],
  [
    "Starting — connecting to the Discord gateway.",
    "启动 — 连接到 Discord 网关。",
    "시작 — Discord 게이트웨이에 연결 중.",
    "開始 — Discord ゲートウェイに接続中。",
    "بدء — الاتصال ببوابة Discord.",
    "Avvio — connessione al gateway di Discord."
  ],
  [
    "Starting — opening Socket Mode connection.",
    "启动 — 打开 Socket 模式连接。",
    "시작 — 소켓 모드 연결 열기.",
    "開始 — ソケットモード接続を開いています。",
    "بدء — فتح اتصال وضع المقابس.",
    "Avvio — apertura della connessione in Modalità Socket."
  ],
  [
    "Starting — waiting for Telegram getUpdates to succeed.",
    "启动 — 等待 Telegram getUpdates 成功。",
    "시작 — Telegram getUpdates 성공 대기 중.",
    "開始 — Telegram の getUpdates が成功するのを待っています。",
    "بدء — انتظار نجاح getUpdates في Telegram.",
    "Avvio — attesa del successo del getUpdates di Telegram."
  ],
  [
    "Starting {0}…",
    "启动 {0}…",
    "{0} 시작 중…",
    "開始 {0}…",
    "بدء {0}…",
    "Avvio {0}…"
  ],
  [
    "Starting server ({0})…",
    "启动服务器（{0}）…",
    "서버({0}) 시작 중…",
    "サーバーを開始中 ({0})…",
    "بدء الخادم ({0})…",
    "Avvio del server ({0})…"
  ],
  [
    "Starting…",
    "启动…",
    "시작 중…",
    "開始…",
    "بدء…",
    "Avvio…"
  ],
  [
    "Starts the browser if needed, then navigates. After this, call browser_snapshot",
    "如果需要，启动浏览器，然后导航。之后，调用 browser_snapshot",
    "필요시 브라우저를 시작한 후 이동합니다. 이 후 browser_snapshot을 호출하세요.",
    "必要に応じてブラウザを起動し、その後ナビゲートします。その後、browser_snapshot を呼び出してください。",
    "يبدأ المتصفح إذا لزم الأمر، ثم ينتقل. بعد ذلك، قم باستدعاء browser_snapshot",
    "Avvia il browser se necessario, quindi naviga. Dopo questo, chiama browser_snapshot"
  ],
  [
    "State:",
    "状态：",
    "상태:",
    "状態:",
    "الحالة:",
    "Stato:"
  ],
  [
    "status",
    "状态",
    "상태",
    "ステータス",
    "الحالة",
    "stato"
  ],
  [
    "Status",
    "状态",
    "상태",
    "状態",
    "الحالة",
    "Stato"
  ],
  [
    "Status:",
    "状态：",
    "상태:",
    "ステータス:",
    "الحالة:",
    "Stato:"
  ],
  [
    "stderr (informational)",
    "stderr（信息）",
    "표준 오류 (정보)",
    "標準エラー（情報）",
    "stderr (معلومات)",
    "stderr (informativo)"
  ],
  [
    "Step",
    "步骤",
    "단계",
    "ステップ",
    "الخطوة",
    "Passo"
  ],
  [
    "Step {0}/{1}: {2}",
    "步骤 {0}/{1}：{2}",
    "단계 {0}/{1}: {2}",
    "ステップ {0}/{1}: {2}",
    "الخطوة {0}/{1}: {2}",
    "Passo {0}/{1}: {2}"
  ],
  [
    "steps",
    "步骤",
    "단계들",
    "ステップ数",
    "خطوات",
    "passi"
  ],
  [
    "Stop",
    "停止",
    "중지",
    "停止",
    "إيقاف",
    "Ferma"
  ],
  [
    "stop {0}: {1}",
    "停止 {0}：{1}",
    "중지 {0}: {1}",
    "停止 {0}: {1}",
    "إيقاف {0}: {1}",
    "ferma {0}: {1}"
  ],
  [
    "Stop after this many chunks (0 = all). Useful to preview cost first.",
    "在处理此数量的块后停止（0 = 全部）。有助于先预览成本。",
    "이 작은 조각 수 이후에 중지 (0 = 모두). 먼저 비용을 미리 보는 데 유용합니다.",
    "このチャンク数後に停止（0 = 全て）。最初にコストを確認するのに便利です。",
    "إيقاف بعد هذا العدد من الأجزاء (0 = جميعها). مفيد لمعاينة التكلفة أولاً.",
    "Fermati dopo questo numero di segmenti (0 = tutti). Utile per visualizzare prima il costo."
  ],
  [
    "Stop dictation",
    "停止听写",
    "받아쓰기 중지",
    "口述を停止",
    "إيقاف الإملاء",
    "Interrompi dettatura"
  ],
  [
    "Stop remote control",
    "停止远程控制",
    "원격 제어 중지",
    "リモートコントロールを停止",
    "إيقاف التحكم عن بعد",
    "Interrompi telecomando"
  ],
  [
    "Stop the in-flight dispatch",
    "停止飞行中的调度",
    "비행중인 디스패치 중지",
    "飛行中の配送を停止",
    "إيقاف الإرسال أثناء الطيران",
    "Interrompi la gestione in volo"
  ],
  [
    "Stop the second agent",
    "停止第二个代理",
    "두 번째 에이전트 중지",
    "2番目のエージェントを停止",
    "إيقاف الوكيل الثاني",
    "Interrompi il secondo agente"
  ],
  [
    "stopped",
    "已停止",
    "중지됨",
    "停止済み",
    "تم الإيقاف",
    "fermato"
  ],
  [
    "Stopped",
    "停止",
    "멈췄다",
    "停止しました",
    "توقف",
    "Fermato"
  ],
  [
    "Stopped — last error: {0}",
    "已停止 — 最近的错误：{0}",
    "중지됨 — 마지막 오류: {0}",
    "停止済み — 最後のエラー: {0}",
    "تم الإيقاف — آخر خطأ: {0}",
    "Fermato — ultimo errore: {0}"
  ],
  [
    "Stopped.",
    "已停止。",
    "중지됨.",
    "停止しました。",
    "توقف.",
    "Fermato."
  ],
  [
    "Storage audit",
    "存储审计",
    "저장 감사",
    "ストレージ監査",
    "تدقيق التخزين",
    "Verifica archiviazione"
  ],
  [
    "stored",
    "已存储",
    "저장됨",
    "保存済み",
    "تم التخزين",
    "archiviato"
  ],
  [
    "Stored as",
    "存储为",
    "다음으로 저장됨",
    "として保存",
    "تم تخزينه كـ",
    "Archiviato come"
  ],
  [
    "Stored locally in the Owllm accounts store. Never sent anywhere except huggingface.co.",
    "存储在本地 Owllm 账户存储中。除 huggingface.co 外，不会发送到其他任何地方。",
    "Owllm 계정 저장소에 로컬로 저장됨. huggingface.co 이외의 다른 곳에는 절대 전송되지 않음.",
    "Owllmアカウントストアにローカルで保存。huggingface.co以外には送信されません。",
    "تم تخزينه محليًا في متجر حسابات Owllm. لم يتم إرساله إلى أي مكان سوى huggingface.co.",
    "Archiviato localmente nello store degli account Owllm. Mai inviato da nessuna parte eccetto huggingface.co."
  ],
  [
    "Stored on this machine",
    "存储在此计算机上",
    "이 기기에 저장됨",
    "このマシンに保存済み",
    "تم تخزينه على هذه الآلة",
    "Archiviato su questa macchina"
  ],
  [
    "string",
    "字符串",
    "문자열",
    "文字列",
    "سلسلة",
    "stringa"
  ],
  [
    "Strip refusal directions from the base model above. Output goes to a new transformers-format directory — quantize to GGUF or run directly afterward.",
    "从上述基础模型中去除拒绝指令。输出到一个新的 transformers 格式目录 — 可以量化为 GGUF 或之后直接运行。",
    "기본 모델에서 거부 지침 제거. 출력은 새로운 transformers 형식 디렉토리로 이동 — GGUF로 양자화하거나 그 직후 바로 실행.",
    "上記の基本モデルから拒否指示を取り除きます。出力は新しいtransformers形式のディレクトリに保存され、GGUFに量子化するか、すぐに実行されます。",
    "قم بإزالة تعليمات الرفض من النموذج الأساسي أعلاه. يتم إخراج النتائج إلى دليل جديد بتنسيق transformers — يمكن تحويله إلى GGUF أو تشغيله مباشرة بعد ذلك.",
    "Rimuovere le istruzioni di rifiuto dalla base del modello sopra. L'output va in una nuova directory in formato transformers — quantizzare in GGUF o eseguire direttamente subito dopo."
  ],
  [
    "Structured reasoning aid — agents emit thoughts in a tracked chain, can revise.",
    "结构化推理辅助 — 代理在跟踪的链中输出思考，可以进行修改。",
    "구조화된 추론 지원 — 에이전트는 추적된 체인에서 생각을 내보내며 수정 가능.",
    "構造化された推論支援 — エージェントは追跡されたチェーンで思考を出力し、修正できます。",
    "مساعدة في التفكير المنظم — وكلاء يصدرون الأفكار في سلسلة متتبعة، يمكن تعديلها.",
    "Supporto al ragionamento strutturato — gli agenti emettono pensieri in una catena tracciata, possono rivedere."
  ],
  [
    "Studio",
    "工作室",
    "스튜디오",
    "スタジオ",
    "استوديو",
    "Studio"
  ],
  [
    "sub",
    "子",
    "서브",
    "サブ",
    "فرعي",
    "sotto"
  ],
  [
    "such as F2/F12/Del during POST). Documented STUBS (backend may return not-implemented):",
    "如POST期间的F2/F12/Del）。已记录的STUBS（后台可能返回未实现）：",
    "POST 중 F2/F12/Del과 같은 것). 문서화된 STUBS (백엔드가 구현되지 않았음을 반환할 수 있음):",
    "POST中のF2/F12/Delなど）。文書化されたSTUB（バックエンドが未実装を返す場合があります）：",
    "مثل F2/F12/Del أثناء POST). نقاط STUBS الموثقة (قد يعيد الخادم الخلفي 'غير منجز'): ",
    "come F2/F12/Del durante il POST). STUBS documentati (il backend può restituire non-implementato):"
  ],
  [
    "super",
    "超级",
    "슈퍼  ",
    "スーパー",
    "رائع",
    "super"
  ],
  [
    "Super User",
    "超级用户",
    "슈퍼 사용자  ",
    "スーパー ユーザー",
    "المستخدم المميز",
    "Super Utente"
  ],
  [
    "SVM Mode",
    "SVM模式",
    "SVM 모드  ",
    "SVM モード",
    "وضع SVM",
    "Modalità SVM"
  ],
  [
    "Switch project",
    "切换项目",
    "프로젝트 전환  ",
    "プロジェクトを切り替える",
    "تبديل المشروع",
    "Cambia progetto"
  ],
  [
    "Switch the browser's device emulation: 'desktop', 'iphone', 'android' or",
    "切换浏览器的设备模拟：'桌面'、'iPhone'、'Android' 或",
    "브라우저의 장치 에뮬레이션 전환: '데스크탑', '아이폰', '안드로이드' 또는  ",
    "ブラウザのデバイスエミュレーションを切り替える: 'デスクトップ', 'iPhone', 'Android' または",
    "تبديل محاكاة جهاز المتصفح: 'سطح المكتب'، 'iPhone'، 'Android' أو",
    "Cambia l'emulazione del dispositivo del browser: 'desktop', 'iphone', 'android' o"
  ],
  [
    "Switch to dark mode",
    "切换到暗黑模式",
    "다크 모드로 전환  ",
    "ダークモードに切り替え",
    "التبديل إلى الوضع الداكن",
    "Passa alla modalità scura"
  ],
  [
    "Switch to light mode",
    "切换到明亮模式",
    "라이트 모드로 전환  ",
    "ライトモードに切り替え",
    "التبديل إلى الوضع الفاتح",
    "Passa alla modalità chiara"
  ],
  [
    "Switch to the Browse tab and click Download on a model card to add one here.",
    "切换到浏览标签页，然后点击模型卡上的下载按钮，将模型添加到此处。",
    "탐색 탭으로 전환하고 모델 카드에서 다운로드를 클릭하여 여기에 추가하세요.  ",
    "[ブラウズ] タブに切り替え、モデルカードの [ダウンロード] をクリックしてここに追加します。",
    "انتقل إلى علامة تبويب التصفح وانقر على تنزيل في بطاقة النموذج لإضافة واحدة هنا.",
    "Passa alla scheda Sfoglia e clicca su Download su una scheda modello per aggiungerne uno qui."
  ],
  [
    "Sync your cloud logins (codex/claude/gemini/kimi + API keys) from Windows into the sandbox. Runs automatically too — use this to re-sync after logging in to a new provider.",
    "将您的云登录（codex/claude/gemini/kimi + API 密钥）从 Windows 同步到沙箱中。也会自动运行 — 登录新提供商后可以使用此功能重新同步。",
    "Windows에서 클라우드 로그인을 샌드박스로 동기화하세요 (codex/claude/gemini/kimi + API 키). 자동 실행도 가능합니다 — 새 제공업체로 로그인한 후 재동기화할 때 사용하세요.  ",
    "クラウドログイン（codex/claude/gemini/kimi + APIキー）を Windows からサンドボックスに同期します。新しいプロバイダーにログインした後、再同期するためにも自動で実行されます。",
    "مزامنة تسجيلات الدخول السحابية الخاصة بك (codex/claude/gemini/kimi + مفاتيح API) من Windows إلى البيئة التجريبية. يعمل تلقائيًا أيضًا — استخدم هذا لإعادة المزامنة بعد تسجيل الدخول إلى مزود جديد.",
    "Sincronizza i tuoi accessi cloud (codex/claude/gemini/kimi + chiavi API) da Windows nella sandbox. Funziona anche automaticamente — usa questo per risincronizzare dopo aver effettuato l'accesso a un nuovo fornitore."
  ],
  [
    "Synced as @",
    "已同步为 @",
    "@로 동기화됨  ",
    "@ として同期されました",
    "تمت المزامنة باسم @",
    "Sincronizzato come @"
  ],
  [
    "System prompt (",
    "系统提示 (",
    "시스템 프롬프트 (  ",
    "システムプロンプト（",
    "موجه النظام (",
    "Prompt di sistema ("
  ],
  [
    "System prompt is empty — nothing to save.",
    "系统提示为空 — 无需保存任何内容。",
    "시스템 프롬프트가 비어 있습니다 — 저장할 내용이 없습니다.",
    "システムプロンプトは空です — 保存するものはありません。",
    "موجه النظام فارغ — لا شيء للحفظ.",
    "Il prompt di sistema è vuoto — nulla da salvare."
  ],
  [
    "T0…",
    "T0…",
    "T0…",
    "T0…",
    "T0…",
    "T0…"
  ],
  [
    "tab to watch it here",
    "切换标签页在此查看",
    "탭을 눌러 여기에서 시청",
    "タブを押してここで見る",
    "اضغط للعرض هنا",
    "scheda per guardarlo qui"
  ],
  [
    "tag",
    "tag",
    "태그",
    "タグ",
    "وسم",
    "etichetta"
  ],
  [
    "tag hub",
    "tag hub",
    "태그 허브",
    "タグハブ",
    "مركز الوسوم",
    "hub di etichette"
  ],
  [
    "tags (optional)",
    "tags（可选）",
    "태그 (선택 사항)",
    "タグ（任意）",
    "الوسوم (اختياري)",
    "etichette (opzionale)"
  ],
  [
    "Take a 'screenshot' first to see the target before acting.",
    "先截个图查看目标，再进行操作。",
    "행동하기 전에 먼저 '스크린샷'을 찍어 목표를 확인하세요.",
    "行動する前に、まず『スクリーンショット』を撮ってターゲットを確認してください。",
    "خذ 'لقطة شاشة' أولاً لرؤية الهدف قبل التصرف.",
    "Fai prima uno 'screenshot' per vedere l'obiettivo prima di agire."
  ],
  [
    "Take OWLLM everywhere",
    "在任何地方使用 OWLLM",
    "어디서나 OWLLM 사용",
    "どこでもOWLLMを使用",
    "خذ OWLLM في كل مكان",
    "Porta OWLLM ovunque"
  ],
  [
    "target / dist / __pycache__ / venv / python_runtime so vendor",
    "目标 / dist / __pycache__ / venv / python_runtime 及供应商",
    "target / dist / __pycache__ / venv / python_runtime 소스 벤더",
    "target / dist / __pycache__ / venv / python_runtime so vendor",
    "target / dist / __pycache__ / venv / python_runtime بحيث يتم التوريد",
    "target / dist / __pycache__ / venv / runtime_python così fornitore"
  ],
  [
    "Target device NAME or id (from your OwLLM Devices list).",
    "目标设备名称或ID（来自您的 OwLLM 设备列表）。",
    "대상 장치 이름 또는 ID (OwLLM 장치 목록에서).",
    "ターゲットデバイスの名前またはID（あなたのOwLLMデバイスリストから）。",
    "اسم الجهاز الهدف أو المعرف (من قائمة أجهزة OwLLM الخاصة بك).",
    "Nome o ID del dispositivo target (dalla tua lista dispositivi OwLLM)."
  ],
  [
    "target path (e.g. C:\\tmp\\note.txt)",
    "目标路径（例如：C:\\tmp\\note.txt）",
    "대상 경로 (예: C:\\tmp\\note.txt)",
    "ターゲットパス（例：C:\\tmp\\note.txt）",
    "مسار الهدف (مثلاً C:\\tmp\\note.txt)",
    "Percorso target (es. C:\\tmp\\note.txt)"
  ],
  [
    "TCP port the MCP HTTP server listens on. Default 8763.",
    "MCP HTTP 服务器监听的 TCP 端口。默认 8763。",
    "MCP HTTP 서버가 수신하는 TCP 포트. 기본값 8763.",
    "MCP HTTPサーバーがリッスンするTCPポート。デフォルトは8763。",
    "منفذ TCP الذي يستمع عليه خادم HTTP الخاص بـ MCP. الافتراضي 8763.",
    "Porta TCP su cui il server HTTP MCP ascolta. Default 8763."
  ],
  [
    "team",
    "团队",
    "팀",
    "チーム",
    "فريق",
    "Team"
  ],
  [
    "Team",
    "团队",
    "팀",
    "チーム",
    "فريق",
    "Squadra"
  ],
  [
    "team (decisions, conventions, build/run commands, file locations, gotchas, prior",
    "团队（决策、约定、构建/运行命令、文件位置、注意事项、先前",
    "팀 (결정, 규칙, 빌드/실행 명령, 파일 위치, 주의사항, 이전",
    "チーム（意思決定、規約、ビルド/実行コマンド、ファイルの場所、注意点、以前の",
    "الفريق (القرارات، الاتفاقيات، أوامر البناء/التشغيل، مواقع الملفات، النقاط الحساسة، السابق)",
    "squadra (decisioni, convenzioni, comandi di build/run, posizioni dei file, insidie, precedenti"
  ],
  [
    "Team assembly failed:",
    "团队组装失败：",
    "팀 구성 실패:",
    "チームの組み立てに失敗しました：",
    "فشل تجميع الفريق:",
    "Assemblaggio del Team fallito:"
  ],
  [
    "Team graph ·",
    "团队图 ·",
    "팀 그래프 ·",
    "チームグラフ ·",
    "رسم بياني للفريق ·",
    "Grafico del team ·"
  ],
  [
    "team idle — fed steps start a run",
    "团队空闲 — 提供的步骤开始运行",
    "팀 대기 중 — 연합 단계가 실행을 시작함",
    "チーム待機中 — フェッドステップが実行を開始",
    "الفريق خامل — خطوات التغذية تبدأ التشغيل",
    "team inattivo — i passi del fed iniziano una corsa"
  ],
  [
    "team is running — fed steps steer it live",
    "团队正在运行 — 提供的步骤实时引导",
    "팀 실행 중 — 연합 단계가 실시간으로 조정함",
    "チーム実行中 — フェッドステップがライブで制御",
    "الفريق يعمل — خطوات التغذية تقوده مباشرة",
    "team in esecuzione — i passi del fed la guidano in tempo reale"
  ],
  [
    "team leader",
    "团队领导",
    "팀 리더",
    "チームリーダー",
    "قائد الفريق",
    "team leader"
  ],
  [
    "Team Memory",
    "团队内存",
    "팀 메모리",
    "チームメモリ",
    "ذاكرة الفريق",
    "Memoria del Team"
  ],
  [
    "TEAM MEMORY — a durable, project-wide knowledge base you SHARE with the rest of the",
    "团队记忆 — 一个持久的、项目范围的知识库，你可以与其他人共享",
    "팀 메모리 — 프로젝트 전체에서 내구성 있는 지식 기반으로, 나머지 팀과 공유함",
    "チームメモリ — あなたがプロジェクト全体で共有する耐久性のあるナレッジベース",
    "ذاكرة الفريق — قاعدة معرفة دائمة على مستوى المشروع تشاركها مع الباقي",
    "MEMORIA DEL TEAM — una base di conoscenza duratura e a livello di progetto che CONDIVIDI con il resto del"
  ],
  [
    "Team Memory — the shared knowledge base your agents read and write (build commands, decisions, file maps). Syncs across your PCs via the vault.",
    "团队记忆 — 你的代理读取和写入的共享知识库（构建命令、决策、文件映射）。通过保险库在你的电脑之间同步。",
    "팀 메모리 — 에이전트가 읽고 쓰는 공유 지식 기반 (빌드 명령, 결정, 파일 맵). 금고를 통해 PC 간 동기화됨",
    "チームメモリ — エージェントが読み書きする共有ナレッジベース（ビルドコマンド、決定、ファイルマップ）。ボールトを通じてPC間で同期。",
    "ذاكرة الفريق — قاعدة المعرفة المشتركة التي يقرأ ويكتب فيها وكلاؤك (أوامر البناء، القرارات، خرائط الملفات). تتزامن عبر أجهزة الكمبيوتر الخاصة بك من خلال الخزنة.",
    "Memoria del Team — la base di conoscenza condivisa che i tuoi agenti leggono e scrivono (comandi di costruzione, decisioni, mappe dei file). Si sincronizza tra i tuoi PC tramite la cassaforte."
  ],
  [
    "Team model",
    "团队模型",
    "팀 모델",
    "チームモデル",
    "نموذج الفريق",
    "Modello del team"
  ],
  [
    "TEAM MODEL · assigns to every agent",
    "团队模型 · 分配给每个代理",
    "팀 모델 · 모든 에이전트에 할당",
    "チームモデル · 各エージェントに割り当て",
    "نموذج الفريق · يخصص لكل وكيل",
    "MODELLO DEL TEAM · assegna a ogni agente"
  ],
  [
    "Team name",
    "团队名称",
    "팀 이름",
    "チーム名",
    "اسم الفريق",
    "Nome del team"
  ],
  [
    "Team role",
    "团队角色",
    "팀 역할",
    "チームの役割",
    "دور الفريق",
    "Ruolo del team"
  ],
  [
    "Team run in progress",
    "团队运行中",
    "진행 중인 팀 실행",
    "チーム実行中",
    "تشغيل الفريق جارٍ",
    "Esecuzione del team in corso"
  ],
  [
    "Team template",
    "团队模板",
    "팀 템플릿",
    "チームテンプレート",
    "نموذج الفريق",
    "Template del team"
  ],
  [
    "Team: {0} ({1} agents)",
    "团队：{0}（{1} 名代理人）",
    "팀: {0} ({1} 에이전트)",
    "チーム: {0} ({1} エージェント)",
    "الفريق: {0} ({1} وكلاء)",
    "Team: {0} ({1} agenti)"
  ],
  [
    "Team…",
    "团队…",
    "팀…",
    "チーム…",
    "الفريق…",
    "Team…"
  ],
  [
    "teams",
    "团队",
    "팀들",
    "チーム",
    "الفرق",
    "teams"
  ],
  [
    "Telegram",
    "Telegram",
    "텔레그램",
    "Telegram",
    "تيليجرام",
    "Telegram"
  ],
  [
    "Telegram polling is not connected.",
    "Telegram 投票未连接。",
    "텔레그램 폴링이 연결되어 있지 않습니다.",
    "Telegram のポーリングは接続されていません。",
    "استطلاع تيليجرام غير متصل.",
    "Il sondaggio di Telegram non è connesso."
  ],
  [
    "temp",
    "临时",
    "임시",
    "TEMP",
    "مؤقت",
    "TEMP"
  ],
  [
    "Temp",
    "温度",
    "임시",
    "温度",
    "درجة الحرارة",
    "Temperatura"
  ],
  [
    "TEMP",
    "临时",
    "임시",
    "TEMP",
    "مؤقت",
    "TEMP"
  ],
  [
    "Temperature",
    "温度",
    "온도",
    "温度",
    "درجة الحرارة",
    "Temperatura"
  ],
  [
    "Template not installed",
    "模板未安装",
    "템플릿이 설치되지 않았습니다",
    "テンプレートがインストールされていません",
    "النموذج غير مثبت",
    "Template non installato"
  ],
  [
    "terminal",
    "终端",
    "터미널",
    "端末",
    "طرفية",
    "terminale"
  ],
  [
    "Terminal",
    "终端",
    "터미널",
    "端末",
    "نهائي",
    "Terminale"
  ],
  [
    "Test",
    "测试",
    "테스트",
    "テスト",
    "اختبار",
    "Test"
  ],
  [
    "that keeps the user's cookies/logins across calls (not a headless scrape).",
    "该功能在多次调用之间保持用户的 cookies/登录状态（不是无头抓取）。",
    "사용자의 쿠키/로그인을 호출 간 계속 유지합니다 (헤드리스 스크랩이 아님).",
    "ユーザーのクッキー/ログインを通話間で保持するもの（ヘッドレススクレイプではありません）。",
    "التي تحتفظ بملفات تعريف الارتباط/تسجيلات دخول المستخدم عبر المكالمات (ليس استخراج بيانات بدون واجهة مستخدم).",
    "che mantiene i cookie/login dell'utente tra le chiamate (non uno scraping headless)."
  ],
  [
    "That machine hasn't published a dialable address yet. Open its Devices page and enable remote control — the address syncs here via your vault.",
    "那台机器尚未发布可拨号地址。打开它的设备页面并启用远程控制——地址会通过你的保险库同步到这里。",
    "그 기계는 아직 전화 연결 가능한 주소를 공개하지 않았습니다. 장치 페이지를 열고 원격 제어를 활성화하세요 — 주소가 금고를 통해 여기에 동기화됩니다.",
    "そのマシンはまだダイヤル可能なアドレスを公開していません。デバイスページを開き、リモートコントロールを有効にしてください — アドレスはボールトを通じてここに同期されます。",
    "لم تنشر تلك الآلة بعد عنوانًا يمكن الاتصال به. افتح صفحة أجهزتها وقم بتمكين التحكم عن بُعد — العنوان يتم مزامنته هنا عبر خزنتك.",
    "Quella macchina non ha ancora pubblicato un indirizzo raggiungibile. Apri la sua pagina Dispositivi e abilita il controllo remoto — l'indirizzo si sincronizza qui tramite il tuo vault."
  ],
  [
    "The agent is working — elapsed time",
    "代理正在工作——已过去的时间",
    "에이전트가 작동 중 — 경과 시간",
    "エージェントは作業中 — 経過時間",
    "الوكيل يعمل — الوقت المنقضي",
    "L'agente sta lavorando — tempo trascorso"
  ],
  [
    "The agent's tools run inside",
    "代理的工具在内部运行",
    "에이전트의 도구는 내부에서 실행됩니다",
    "エージェントのツールは内部で実行されます",
    "أدوات الوكيل تعمل داخليًا",
    "Gli strumenti dell'agente vengono eseguiti all'interno"
  ],
  [
    "The agents' browser is a real window they drive with the browser_* tools (open pages, click, type, fill forms). Open a URL above to start it and pre-log into a site — the agents inherit the session. Local dev servers work too (localhost:5173 opens as http), and the DEVICE chips preview mobile layouts.",
    "代理的浏览器是真实的窗口，他们使用 browser_* 工具操作（打开页面、点击、输入、填写表单）。在上方打开一个 URL 即可启动，并预先登录一个网站——代理会继承该会话。本地开发服务器也可以使用（localhost:5173 会以 http 打开），而 DEVICE 芯片可以预览移动布局。",
    "에이전트의 브라우저는 browser_* 도구(open pages, click, type, fill forms)로 제어하는 실제 창입니다. 위의 URL을 열어 시작하고 사이트에 미리 로그인하면 에이전트가 세션을 상속받습니다. 로컬 개발 서버도 사용 가능하며(localhost:5173는 http로 열림), DEVICE 칩은 모바일 레이아웃을 미리보기 합니다.",
    "エージェントのブラウザは、browser_* ツール（ページの開閉、クリック、入力、フォームの記入）で操作できる実際のウィンドウです。上のURLを開いて起動し、サイトに事前にログインしてください — エージェントはセッションを引き継ぎます。ローカル開発サーバーも動作します（localhost:5173 は http として開かれます）、DEVICE チップはモバイルレイアウトをプレビューします。",
    "متصفح الوكلاء هو نافذة حقيقية يتحكمون فيها باستخدام أدوات المتصفح_* (فتح صفحات، النقر، الكتابة، ملء النماذج). افتح رابط URL أعلاه لبدء تشغيله وتسجيل الدخول مسبقًا إلى موقع — الوكلاء يرثون الجلسة. تعمل خوادم التطوير المحلية أيضًا (localhost:5173 يفتح كـ http)، وتقوم رقائق DEVICE بمعاينة تخطيطات الهواتف المحمولة.",
    "Il browser dell'agente è una finestra reale che controllano con gli strumenti browser_* (aprire pagine, cliccare, digitare, compilare moduli). Apri un URL sopra per avviarlo e accedere preventivamente a un sito — gli agenti ereditano la sessione. Funzionano anche i server di sviluppo locali (localhost:5173 viene aperto come http), e i chip DEVICE mostrano l'anteprima dei layout mobili."
  ],
  [
    "The browser is a visible window; use browser_snapshot for the element list and",
    "浏览器是一个可见窗口；使用 browser_snapshot 获取元素列表。",
    "브라우저는 보이는 창이며; 요소 목록은 browser_snapshot을 사용하세요",
    "ブラウザは可視ウィンドウです；要素リストには browser_snapshot を使用してください",
    "المتصفح هو نافذة مرئية؛ استخدم browser_snapshot لقائمة العناصر و",
    "Il browser è una finestra visibile; usa browser_snapshot per l'elenco degli elementi e"
  ],
  [
    "The bundled file stays read-only; Save writes an editable override that the app loads instead — so your changes take effect and persist.",
    "捆绑的文件保持只读；保存会写入一个可编辑的覆盖文件，应用会加载它——这样你的更改就会生效并持续存在。",
    "번들 파일은 읽기 전용으로 유지됩니다; 저장하면 앱이 대신 로드하는 편집 가능한 오버라이드를 작성합니다 — 따라서 변경 사항이 적용되고 지속됩니다.",
    "バンドルされたファイルは読み取り専用のままです；保存すると編集可能なオーバーライドが書き込まれ、アプリは代わりにそれを読み込みます — そのため変更は反映され持続します。",
    "الملف المدمج يبقى للقراءة فقط؛ حفظ يقوم بكتابة نسخة قابلة للتحرير يتم تحميلها بواسطة التطبيق بدلاً من ذلك — بحيث تصبح تغييراتك فعالة وتستمر.",
    "Il file incluso rimane di sola lettura; Salva scrive una versione modificabile che l'app carica al suo posto — quindi le tue modifiche avranno effetto e persisteranno."
  ],
  [
    "The Coder and fine-tuning now run inside Linux. Nothing else to do.",
    "Coder 和微调现在在 Linux 内运行。无需其他操作。",
    "Coder와 fine-tuning은 이제 Linux 내에서 실행됩니다. 다른 추가 작업은 필요 없습니다.",
    "Coder とファインチューニングは現在 Linux 内で実行されます。他に行うことはありません。",
    "المدوّن وبرمجة الضبط الدقيق تعمل الآن داخل لينوكس. لا شيء آخر للقيام به.",
    "Il Coder e il fine-tuning ora vengono eseguiti all'interno di Linux. Non c'è altro da fare."
  ],
  [
    "The context window the running server actually loaded with (live from llama-server). The presets below are the size for the NEXT start.",
    "运行服务器实际加载的上下文窗口（来自 llama-server 的实时数据）。下面的预设是下一次启动的大小。",
    "실행 중인 서버가 실제로 로드한 컨텍스트 창(라이브로 llama-server에서). 아래의 프리셋은 다음 시작 시의 크기입니다.",
    "実行中のサーバーが実際に読み込んだコンテキストウィンドウ（llama-serverからライブ）。以下のプリセットは次回起動時のサイズです。",
    "نافذة السياق التي قام الخادم الجاري بتشغيلها بتحميلها فعليًا (مباشر من خادم لاما). الإعدادات المسبقة أدناه هي الحجم لبدء التشغيل التالي.",
    "La finestra di contesto che il server in esecuzione ha effettivamente caricato (in tempo reale dal llama-server). Le impostazioni di seguito sono la dimensione per il PROSSIMO avvio."
  ],
  [
    "The exact key the fact was saved under (e.g. 'build_command').",
    "事实保存的确切键（例如 'build_command'）。",
    "사실이 저장된 정확한 키(예: 'build_command').",
    "事実が保存された正確なキー（例：'build_command'）。",
    "المفتاح الدقيق الذي تم حفظ المعلومة تحته (مثل 'build_command').",
    "La chiave esatta sotto la quale è stato salvato il fatto (es. 'build_command')."
  ],
  [
    "The fact/decision to remember, stated plainly and self-contained.",
    "要记住的事实/决定，明确且自包含。",
    "기억할 사실/결정을 명확하고 독립적으로 서술.",
    "記憶する事実／決定を、簡潔かつ独立した形で述べる。",
    "الحقيقة / القرار الذي يجب تذكره، مُصرح به بوضوح ومكتفٍ بذاته.",
    "Il fatto/decisione da ricordare, dichiarato chiaramente e in modo autonomo."
  ],
  [
    "The fine-tuning environment this run will use — click to change",
    "本次运行将使用的微调环境 — 点击更改",
    "이번 실행에서 사용될 파인튜닝 환경 — 클릭하여 변경",
    "この実行で使用するファインチューニング環境 — クリックして変更",
    "بيئة التخصيص الدقيقة التي سيستخدمها هذا التشغيل — انقر لتغييرها.",
    "L'ambiente di fine-tuning che questa esecuzione utilizzerà — clicca per cambiare"
  ],
  [
    "The full file contents to write.",
    "要写入的完整文件内容。",
    "작성할 전체 파일 내용.",
    "書き込むファイルの全内容。",
    "المحتويات الكاملة للملف للكتابة.",
    "Il contenuto completo del file da scrivere."
  ],
  [
    "The Gamify HQ is still being built — explore, but expect changes.",
    "Gamify 总部仍在建设中 — 可以探索，但请预期会有变化。",
    "Gamify HQ는 아직 구축 중입니다 — 탐색은 가능하지만 변경 사항이 있을 수 있음.",
    "Gamify HQはまだ構築中 — 探索は可能だが、変更があることを想定。",
    "مقر Gamify لا يزال قيد الإنشاء — استكشف، لكن توقع التغييرات.",
    "Il quartier generale di Gamify è ancora in costruzione — esplora, ma aspettati cambiamenti."
  ],
  [
    "The GitHub repo releases publish TO (gh release). May differ from origin — OwLLM's source is private while its releases repo is public. Saved on the committed .owllm/project.json.",
    "GitHub 仓库的发布会发布到 (gh release)。可能与源不同 — OwLLM 的源代码是私有的，而其发布仓库是公开的。已保存在提交的 .owllm/project.json 中。",
    "GitHub 리포지토리 릴리스가 게시되는 위치(gh release). 원본과 다를 수 있음 — OwLLM의 소스는 비공개이며 릴리스 리포지토리는 공개. 커밋된 .owllm/project.json에 저장됨.",
    "GitHubリポジトリのリリースは（gh release）に公開される。オリジンと異なる場合がある — OwLLMのソースは非公開だが、リリース用リポジトリは公開。コミットされた.owllm/project.jsonに保存。",
    "إصدارات مستودع GitHub تنشر إلى (gh release). قد تختلف عن الأصل — مصدر OwLLM خاص بينما مستودع الإصدارات عام. محفوظ في الملف المُلتزم به .owllm/project.json.",
    "Le release del repository GitHub vengono pubblicate SU (gh release). Possono differire dall'origine — il source di OwLLM è privato mentre il repository delle release è pubblico. Salvato nel file .owllm/project.json committato."
  ],
  [
    "the most recent).",
    "最新的）。",
    "가장 최근의).",
    "最新のもの)。",
    "الأحدث).",
    "il più recente)."
  ],
  [
    "The option value to select.",
    "要选择的选项值。",
    "선택할 옵션 값.",
    "選択するオプションの値。",
    "قيمة الخيار للاختيار.",
    "Il valore dell'opzione da selezionare."
  ],
  [
    "The page reloads; call browser_snapshot afterward for fresh element indexes.",
    "页面会重新加载；随后调用 browser_snapshot 以获取最新的元素索引。",
    "페이지가 다시 로드됩니다; 새 요소 인덱스를 위해 이후에 browser_snapshot을 호출하세요.",
    "ページがリロードされます；新しい要素インデックスのためにその後で browser_snapshot を呼び出してください。",
    "يتم إعادة تحميل الصفحة؛ استدعِ browser_snapshot بعد ذلك للحصول على فهارس العناصر المحدثة.",
    "La pagina si ricarica; chiamare browser_snapshot successivamente per ottenere indici degli elementi aggiornati."
  ],
  [
    "the project's OWN files (README, docs/, comments) — find those with read_file /",
    "项目的自有文件（README、docs/、注释）——使用 read_file / 查找这些文件",
    "프로젝트의 자체 파일(README, docs/, 주석) — read_file /로 찾기",
    "プロジェクトの独自のファイル（README、docs/、コメント） — read_file / で見つけます",
    "ملفات المشروع الخاصة (README، docs/، التعليقات) — ابحث عن تلك باستخدام read_file /",
    "i file PROPRI del progetto (README, docs/, commenti) — trovali con read_file /"
  ],
  [
    "The publish pipeline signs with a cert already mounted on the host (Windows store, hardware token, or a cloud signer like SimplySign). Point it at one by thumbprint or subject — these map to the",
    "发布管道使用已挂载在主机上的证书进行签名（Windows 商店、硬件令牌或像 SimplySign 这样的云签名器）。通过指纹或主题指向它——这些映射到",
    "게시 파이프라인은 이미 호스트에 장착된 인증서(Windows 스토어, 하드웨어 토큰, 또는 SimplySign과 같은 클라우드 서명자)로 서명합니다. 지문이나 주체(subject)로 지정하세요 — 이것들은 다음과 매핑됩니다",
    "公開パイプラインは、既にホストにマウントされている証明書で署名します（Windows ストア、ハードウェアトークン、または SimplySign のようなクラウドサイナー）。親指の印やサブジェクトでそれを指し示す — これらは以下にマッピングされます",
    "خط أنابيب النشر يوقع باستخدام شهادة مثبتة بالفعل على الجهاز المضيف (متجر Windows، وحدة حماية، أو موّقع سحابي مثل SimplySign). وجهه باستخدام البصمة أو الموضوع — هذه تربط إلى",
    "La pipeline di pubblicazione firma con un certificato già montato sull'host (Windows store, token hardware, o un firmatario cloud come SimplySign). Indicalo tramite impronta digitale o soggetto — questi corrispondono a"
  ],
  [
    "The selected device does not report WSL — pick another target or a different mode.",
    "所选设备未报告 WSL——请选择另一个目标或不同模式。",
    "선택한 장치는 WSL을 보고하지 않습니다 — 다른 대상이나 다른 모드를 선택하세요.",
    "選択されたデバイスは WSL を報告しません — 別のターゲットか別のモードを選んでください。",
    "الجهاز المحدد لا يبلغ عن WSL — اختر هدفًا آخر أو وضعًا مختلفًا.",
    "Il dispositivo selezionato non segnala WSL — scegli un altro target o una modalità diversa."
  ],
  [
    "The shell command line to run.",
    "要运行的 shell 命令行。",
    "실행할 셸 명령줄.",
    "実行するシェルコマンドライン。",
    "سطر أوامر الصدفة للتشغيل.",
    "La riga di comando della shell da eseguire."
  ],
  [
    "The shell command to run on the remote device.",
    "要在远程设备上运行的 shell 命令。",
    "원격 장치에서 실행할 셸 명령.",
    "リモートデバイスで実行するシェルコマンド。",
    "أمر الصدفة للتشغيل على الجهاز البعيد.",
    "Il comando della shell da eseguire sul dispositivo remoto."
  ],
  [
    "The shell command to run on the remote host.",
    "要在远程主机上运行的 shell 命令。",
    "원격 호스트에서 실행할 셸 명령입니다.",
    "リモートホストで実行するシェルコマンドです。",
    "أمر الشل للتنفيذ على المضيف البعيد.",
    "Il comando shell da eseguire sull'host remoto."
  ],
  [
    "The skill's name or id (e.g. 'pdf-processing').",
    "技能的名称或 ID（例如 'pdf-processing'）。",
    "스킬의 이름 또는 ID (예: 'pdf-processing').",
    "スキルの名前またはID（例: 'pdf-processing'）。",
    "اسم المهارة أو معرفها (مثل 'pdf-processing').",
    "Il nome o l'id della skill (es. 'pdf-processing')."
  ],
  [
    "The source download is still cached at: {0}",
    "源下载仍缓存于：{0}",
    "소스 다운로드가 여전히 캐시에 있습니다: {0}",
    "ソースのダウンロードはまだキャッシュされています: {0}",
    "لا يزال تنزيل المصدر مخزّنًا مؤقتًا في: {0}",
    "Il download della fonte è ancora memorizzato nella cache in: {0}"
  ],
  [
    "The stored thumbprint isn't mounted right now — plug the token / start SimplySign.",
    "存储的指纹当前未挂载 —— 插入令牌 / 启动 SimplySign。",
    "저장된 지문이 현재 장착되어 있지 않습니다 — 토큰을 연결하거나 SimplySign을 시작하세요.",
    "保存されたサムプリントは現在マウントされていません — トークンを差し込む / SimplySignを起動してください。",
    "البصمة المخزنة غير مركبة حاليًا — قم بتوصيل الرمز / بدء SimplySign.",
    "L'impronta salvata non è montata in questo momento — collega il token / avvia SimplySign."
  ],
  [
    "The team is running — elapsed time",
    "团队正在运行 —— 已经过的时间",
    "팀이 실행 중입니다 — 경과 시간",
    "チームが実行中 — 経過時間",
    "الفريق يعمل — الوقت المنقضي",
    "Il team sta lavorando — tempo trascorso"
  ],
  [
    "The text to type into the field.",
    "要输入到字段的文本。",
    "필드에 입력할 텍스트입니다.",
    "フィールドに入力するテキスト。",
    "النص الذي يجب كتابته في الحقل.",
    "Il testo da digitare nel campo."
  ],
  [
    "the tools it grants, and its instructions.",
    "它授予的工具及其说明。",
    "제공하는 도구와 지침입니다.",
    "付与されるツールと、その指示。",
    "الأدوات التي يمنحها، وتعليماته.",
    "Gli strumenti che concede e le sue istruzioni."
  ],
  [
    "The Watcher",
    "观察者",
    "Watcher",
    "ウォッチャー",
    "المراقب",
    "Il Watcher"
  ],
  [
    "The Watcher — OWLLM's support assistant",
    "观察者 —— OWLLM 的支持助手",
    "Watcher — OWLLM의 지원 어시스턴트",
    "ウォッチャー — OWLLMのサポートアシスタント",
    "المراقب — مساعد دعم OWLLM",
    "Il Watcher — assistente di supporto di OWLLM"
  ],
  [
    "The Watcher ↑",
    "观察者 ↑",
    "Watcher ↑",
    "ウォッチャー ↑",
    "المراقب ↑",
    "Il Watcher ↑"
  ],
  [
    "them for older or more specific entries (memory_search with an empty query lists",
    "查找较旧或更具体的条目（memory_search 使用空查询列出）",
    "이전 또는 더 구체적인 항목을 위해 (빈 쿼리로 memory_search를 실행하면 리스트를 표시합니다",
    "古いまたはより具体的なエントリを検索する場合（空のクエリでmemory_searchはリストします",
    "للحالات الأقدم أو الإدخالات الأكثر تحديدًا (memory_search مع استعلام فارغ يعرض",
    "loro per voci più vecchie o più specifiche (memory_search con una query vuota elenca"
  ],
  [
    "These are HuggingFace",
    "这些是 HuggingFace",
    "이것들은 HuggingFace입니다",
    "これらはHuggingFaceです",
    "هذه هي HuggingFace",
    "Questi sono HuggingFace"
  ],
  [
    "These keys appear empty: {0} The server will likely fail to start without them. Add anyway?",
    "这些密钥似乎为空: {0} 没有它们服务器可能无法启动。仍然添加吗？",
    "이 키들은 비어 있는 것으로 보입니다: {0} 서버는 이 키들 없이 시작하지 못할 가능성이 높습니다. 그래도 추가하시겠습니까?",
    "これらのキーは空のようです: {0} サーバーはこれらなしでは起動に失敗する可能性があります。それでも追加しますか？",
    "تظهر هذه المفاتيح فارغة: {0} من المحتمل أن يفشل الخادم في البدء بدونها. هل تريد الإضافة على أي حال؟",
    "Queste chiavi appaiono vuote: {0} Il server probabilmente non si avvierà senza di esse. Aggiungerle comunque?"
  ],
  [
    "They will run OUTSIDE the sandbox — able to read and write files anywhere, run system commands, and use the network, exactly like you can. The folder-only protection is removed for THIS project only.",
    "他们将跳出沙箱——能够在任何地方读写文件、运行系统命令并使用网络，就像你一样。仅针对这个项目，文件夹限制保护被移除。",
    "그들은 샌드박스 외부에서 실행됩니다 — 파일을 어디서나 읽고 쓸 수 있으며, 시스템 명령을 실행하고 네트워크를 사용할 수 있습니다. 이는 사용자가 할 수 있는 것과 동일합니다. 폴더 전용 보호는 이 프로젝트에서만 제거됩니다.",
    "これらはサンドボックスの外で実行されます — ファイルをどこでも読み書きでき、システムコマンドを実行でき、ネットワークを使用できます。まるであなたができるのと同じです。フォルダのみの保護はこのプロジェクトだけで解除されます。",
    "سيتم تشغيلها خارج بيئة الحماية — قادرة على قراءة وكتابة الملفات في أي مكان، وتشغيل أوامر النظام، واستخدام الشبكة، تمامًا كما يمكنك أنت. تمت إزالة الحماية على مستوى المجلد فقط لهذا المشروع.",
    "Eseguiranno FUORI dalla sandbox — potranno leggere e scrivere file ovunque, eseguire comandi di sistema e usare la rete, esattamente come puoi fare tu. La protezione a livello di cartella è rimossa solo per QUESTO progetto."
  ],
  [
    "Think out loud here while the agents work: decisions, bugs, UI ideas, files to touch. Press Ctrl+Enter or use Digest notes to turn this into a plan and feedable steps.",
    "在代理工作时在这里大声思考：决策、错误、UI 想法、需要修改的文件。按 Ctrl+Enter 或使用摘要笔记将其变为计划和可执行步骤。",
    "에이전트가 작업하는 동안 여기서 생각을 정리하세요: 결정 사항, 버그, UI 아이디어, 다뤄야 할 파일 등. Ctrl+Enter를 누르거나 다이제스트 노트를 사용하여 이를 계획 및 실행 가능한 단계로 바꾸세요.",
    "エージェントが作業している間にここで考えを口にしてください: 決定、バグ、UIアイデア、触るべきファイルなど。Ctrl+Enterを押すか、Digestノートを使ってこれを計画と実行可能なステップに変換してください。",
    "فكر بصوت عالٍ هنا بينما يعمل الوكلاء: القرارات، الأخطاء، أفكار واجهة المستخدم، الملفات التي يجب التعامل معها. اضغط Ctrl+Enter أو استخدم ملاحظات Digest لتحويل هذا إلى خطة وخطوات قابلة للتنفيذ.",
    "Pensa ad alta voce qui mentre gli agenti lavorano: decisioni, bug, idee per l'interfaccia, file da modificare. Premi Ctrl+Invio o usa le note Digest per trasformarlo in un piano e passaggi utilizzabili."
  ],
  [
    "This also removes its sandbox copy inside WSL (frees that disk space). Your original folder, if any, stays put.",
    "这也会删除它在 WSL 中的沙箱副本（释放那个磁盘空间）。你的原始文件夹（如果有的话）会保持原位。",
    "이는 또한 WSL 내의 샌드박스 복사본을 제거합니다 (해당 디스크 공간 확보). 원본 폴더는 그대로 유지됩니다.",
    "これにより、WSL内のサンドボックスコピーも削除されます（そのディスクスペースが解放されます）。元のフォルダは、そのまま残ります。",
    "هذا أيضًا يزيل نسخة بيئة الحماية داخل WSL (يحرر مساحة القرص). المجلد الأصلي الخاص بك، إن وجد، يبقى في مكانه.",
    "Questo rimuove anche la sua copia sandbox all'interno di WSL (libera quello spazio su disco). La tua cartella originale, se presente, resterà al suo posto."
  ],
  [
    "This app's recorded traffic for this provider — token count is an estimate (~4 chars/token).",
    "这个应用程序为此提供商记录的流量——令牌数量为估计值（大约4个字符/令牌）。",
    "이 앱의 해당 제공자에 대한 기록된 트래픽 — 토큰 수는 추정치입니다 (~4자/토큰).",
    "このアプリのこのプロバイダーに対する記録済みトラフィック — トークン数は推定です（約4文字/トークン）。",
    "تم تسجيل حركة المرور لهذا التطبيق بالنسبة لمزود الخدمة هذا — عدد الرموز هو تقديري (~4 أحرف/رمز).",
    "Il traffico registrato da quest'app per questo provider — il conteggio dei token è una stima (~4 caratteri/token)."
  ],
  [
    "This arrow lets",
    "这个箭头可以",
    "이 화살표는",
    "この矢印は",
    "هذا السهم يتيح",
    "Questa freccia consente"
  ],
  [
    "This bumps the version, commits, tags, and pushes. The repository's GitHub Actions workflow will build and publish a public release.",
    "这会提升版本、提交、打标签并推送。仓库的 GitHub Actions 工作流将构建并发布一个公开版本。",
    "이것은 버전을 올리고, 커밋하고, 태그를 추가하고, 푸시합니다. 리포지토리의 GitHub Actions 워크플로우가 빌드하고 공개 릴리스를 게시합니다.",
    "これはバージョンを上げ、コミットし、タグを付けてプッシュします。リポジトリのGitHub Actionsワークフローは、公開リリースをビルドして公開します。",
    "هذا يرفع الإصدار، ويقوم بالالتزام، ويضع العلامات، ويدفع التغييرات. سيتولى سير عمل GitHub Actions للمستودع بناء ونشر الإصدار العام.",
    "Questo aggiorna la versione, esegue commit, crea tag e push. Il flusso di lavoro GitHub Actions del repository costruirà e pubblicherà una release pubblica."
  ],
  [
    "This bumps the version, commits, tags, and pushes. The repository's GitHub Actions workflow will build and publish the release.",
    "这会提升版本、提交、打标签并推送。仓库的 GitHub Actions 工作流将构建并发布该版本。",
    "이것은 버전을 올리고, 커밋하고, 태그를 추가하고, 푸시합니다. 리포지토리의 GitHub Actions 워크플로우가 빌드하고 릴리스를 게시합니다.",
    "これはバージョンを上げ、コミットし、タグを付けてプッシュします。リポジトリのGitHub Actionsワークフローは、リリースをビルドして公開します。",
    "هذا يرفع الإصدار، ويقوم بالالتزام، ويضع العلامات، ويدفع التغييرات. سيتولى سير عمل GitHub Actions للمستودع بناء ونشر الإصدار.",
    "Questo aggiorna la versione, esegue commit, crea tag e push. Il flusso di lavoro GitHub Actions del repository costruirà e pubblicherà la release."
  ],
  [
    "This bumps the version, commits, tags, pushes, and runs the host build → {0} → publishes a public release to GitHub.",
    "这会提升版本、提交、更改标签、推送并运行主机构建 → {0} → 发布一个公共版本到 GitHub。",
    "이것은 버전을 올리고, 커밋하고, 태그를 추가하고, 푸시하며, 호스트 빌드 → {0} → GitHub에 공개 릴리스를 게시합니다.",
    "これはバージョンを上げ、コミットし、タグを付け、プッシュし、ホストビルド → {0} を実行し、GitHubに公開リリースを公開します。",
    "هذا يرفع الإصدار، ويقوم بالالتزام، ويضع العلامات، ويدفع التغييرات، ويشغّل بناء المضيف → {0} → ينشر إصداراً عاماً على GitHub.",
    "Questo aggiorna la versione, esegue commit, crea tag, push e esegue la build host → {0} → pubblica una release pubblica su GitHub."
  ],
  [
    "This bumps the version, commits, tags, pushes, and runs the host build → {0} → publishes to GitHub.",
    "这会提升版本、提交、更改标签、推送并运行主机构建 → {0} → 发布到 GitHub。",
    "이것은 버전을 올리고, 커밋하고, 태그를 추가하고, 푸시하며, 호스트 빌드 → {0} → GitHub에 게시합니다.",
    "これはバージョンを上げ、コミットし、タグを付け、プッシュし、ホストビルド → {0} を実行し、GitHubに公開します。",
    "هذا يرفع الإصدار، ويقوم بالالتزام، ويضع العلامات، ويدفع التغييرات، ويشغّل بناء المضيف → {0} → ينشر على GitHub.",
    "Questo aggiorna la versione, esegue commit, crea tag, push e esegue la build host → {0} → pubblica su GitHub."
  ],
  [
    "This cannot be undone.",
    "这是无法撤销的。",
    "이것은 되돌릴 수 없습니다.",
    "これは元に戻せません。",
    "لا يمكن التراجع عن هذا.",
    "Questo non può essere annullato."
  ],
  [
    "This device",
    "这台设备",
    "이 장치",
    "このデバイス",
    "هذا الجهاز",
    "Questo dispositivo"
  ],
  [
    "This folder is also an agentic project — rules and notebook are SHARED with the team pages.",
    "这个文件夹也是一个能动的项目——规则和笔记本已与团队页面共享。",
    "이 폴더는 또한 에이전트 프로젝트입니다 — 규칙과 노트북은 팀 페이지와 공유됩니다.",
    "このフォルダーもまたエージェンシックなプロジェクトです — ルールとノートブックはチームページと共有されています。",
    "هذا المجلد هو أيضًا مشروع وكيل — القواعد والمفكرة مشتركة مع صفحات الفريق.",
    "Questa cartella è anche un progetto agentico — regole e taccuino sono CONDIVISI con le pagine del team."
  ],
  [
    "This is a firmware switch —",
    "这是一个固件开关——",
    "이것은 펌웨어 스위치입니다 —",
    "これはファームウェアスイッチです —",
    "هذا مفتاح البرنامج الثابت —",
    "Questo è un interruttore del firmware —"
  ],
  [
    "This is permanent. Cache may need to be downloaded again; environments may need to be rebuilt.",
    "这是永久性的。可能需要重新下载缓存；可能需要重建环境。",
    "이것은 영구적입니다. 캐시는 다시 다운로드해야 할 수 있으며, 환경은 다시 구축해야 할 수 있습니다.",
    "これは永続的です。キャッシュは再度ダウンロードする必要があるかもしれません；環境を再構築する必要があるかもしれません。",
    "هذا دائم. قد تحتاج الذاكرة المؤقتة إلى التحميل مرة أخرى؛ قد تحتاج البيئات إلى إعادة البناء.",
    "Questo è permanente. La cache potrebbe dover essere scaricata di nuovo; gli ambienti potrebbero dover essere ricostruiti."
  ],
  [
    "This is the same technique that produced models like DavidAU's abliterated Gemma, NousResearch's variants, and the \"supergemma4-abliterated\" entry in your downloaded list.",
    "这与生成模型如 DavidAU 的 abliterated Gemma、NousResearch 的变体，以及你下载列表中的“supergemma4-abliterated”入口使用的是相同的技术。",
    "이것은 DavidAU의 abliterated Gemma, NousResearch의 변형, 그리고 다운로드한 목록의 \"supergemma4-abliterated\" 항목과 같은 모델을 생성한 같은 기술입니다.",
    "これは、DavidAUの消去されたGemma、NousResearchのバリアント、およびダウンロードリストにある「supergemma4-abliterated」のようなモデルを生成したのと同じ技術です。",
    "هذه هي نفس التقنية التي أنتجت نماذج مثل Gemma الممحوة الخاصة بـ DavidAU، والنسخ المتنوعة من NousResearch، والمدخل \"supergemma4-abliterated\" في قائمتك المحملة.",
    "Questa è la stessa tecnica che ha prodotto modelli come l'abbliterata Gemma di DavidAU, le varianti di NousResearch e la voce \"supergemma4-abliterated\" nella tua lista scaricata."
  ],
  [
    "This machine is being controlled remotely.",
    "这台机器正在被远程控制。",
    "이 기계는 원격으로 제어되고 있습니다.",
    "このマシンはリモートで制御されています。",
    "هذه الآلة تُدار عن بُعد.",
    "Questa macchina è controllata da remoto."
  ],
  [
    "This only removes the project; your folder on disk stays.",
    "这只会移除项目；磁盘上的文件夹会保留。",
    "이것은 프로젝트만 제거합니다; 디스크의 폴더는 그대로 있습니다.",
    "これによりプロジェクトだけが削除されます；ディスク上のフォルダーは残ります。",
    "هذا يحذف المشروع فقط؛ يظل مجلدك على القرص.",
    "Questo rimuove solo il progetto; la tua cartella sul disco resta."
  ],
  [
    "This page has a team run in progress — closing it stops the run. Close anyway?",
    "此页面有团队运行正在进行——关闭它将停止运行。仍要关闭吗？",
    "이 페이지에는 팀 실행이 진행 중입니다 — 닫으면 실행이 중지됩니다. 그래도 닫으시겠습니까?",
    "このページではチームの実行が進行中です — 閉じると実行が停止します。それでも閉じますか？",
    "هذه الصفحة تحتوي على تشغيل للفريق جارٍ — إغلاقها يوقف التشغيل. هل تريد الإغلاق على أي حال؟",
    "Questa pagina ha un'esecuzione del team in corso — chiuderla ferma l'esecuzione. Chiudere lo stesso?"
  ],
  [
    "this PC",
    "这台电脑",
    "이 PC",
    "このPC",
    "هذا الكمبيوتر الشخصي",
    "questo PC"
  ],
  [
    "This project has no location set. Pick a folder first so the brainstormer can save BRIEF.md.",
    "此项目未设置位置。请先选择一个文件夹，以便头脑风暴者可以保存 BRIEF.md。",
    "이 프로젝트에는 위치가 설정되어 있지 않습니다. 먼저 폴더를 선택하면 브레인스토머가 BRIEF.md를 저장할 수 있습니다.",
    "このプロジェクトには場所が設定されていません。ブレインストーマーが BRIEF.md を保存できるように、まずフォルダーを選択してください。",
    "هذا المشروع ليس له موقع محدد. اختر مجلدًا أولاً حتى يتمكن مولد الأفكار من حفظ BRIEF.md.",
    "Questo progetto non ha una posizione impostata. Scegli prima una cartella così il brainstormer può salvare BRIEF.md."
  ],
  [
    "This removes the file and its metadata sidecar. It cannot be undone.",
    "这会移除文件及其元数据侧车。无法撤销。",
    "이 파일과 그 메타데이터 사이드카를 제거합니다. 이 작업은 취소할 수 없습니다.",
    "これによりファイルとそのメタデータサイドカーが削除されます。元に戻すことはできません。",
    "هذا يزيل الملف وملحق بياناته المرفق. لا يمكن التراجع عنه.",
    "Questo rimuove il file e il relativo file metadati. Non può essere annullato."
  ],
  [
    "Tick the skills this agent should have in every team — only the ones a task needs get loaded. Click",
    "勾选每个团队中该代理应具备的技能——只有任务需要的技能会被加载。点击 ",
    "이 에이전트가 모든 팀에서 가져야 할 기술을 선택하세요 — 작업에 필요한 기술만 로드됩니다. 클릭",
    "このエージェントがチームごとに持つべきスキルにチェックを入れてください — タスクに必要なものだけが読み込まれます。クリック",
    "حدد المهارات التي يجب أن يمتلكها هذا الوكيل في كل فريق — فقط المهارات التي يحتاجها المهمات يتم تحميلها. انقر",
    "Seleziona le competenze che questo agente dovrebbe avere in ogni team — si caricano solo quelle necessarie per un compito. Clicca"
  ],
  [
    "tier",
    "等级",
    "등급",
    "階層",
    "المستوى",
    "livello"
  ],
  [
    "tight",
    "紧",
    "좁음",
    "タイト",
    "ضيق",
    "attillato"
  ],
  [
    "Tight fit (inference; fine-tuning may struggle)",
    "紧密适配（推理；微调可能会有困难）",
    "타이트한 맞춤(추론; 미세 조정에는 어려움이 있을 수 있음)",
    "タイトフィット（推論; ファインチューニングはうまくいかないかもしれません）",
    "ملاءمة ضيقة (الاستدلال؛ قد تواجه الضبط الدقيق صعوبة)",
    "Adattamento stretto (inferencia; la messa a punto potrebbe avere difficoltà)"
  ],
  [
    "Timestamp URL (RFC3161)",
    "时间戳 URL（RFC3161）",
    "타임스탬프 URL (RFC3161)",
    "タイムスタンプ URL (RFC3161)",
    "عنوان URL للوقت الزمني (RFC3161)",
    "URL con timestamp (RFC3161)"
  ],
  [
    "Timezone-aware time queries + conversion. Tiny, useful for scheduling agents.",
    "时区感知的时间查询 + 转换。小巧，对调度代理很有用。",
    "시간대 인식 시간 쿼리 + 변환. 작지만 에이전트 일정에 유용합니다.",
    "タイムゾーン対応の時間クエリ + 変換。小さいですが、エージェントのスケジューリングに便利です。",
    "استفسارات الوقت المدركة بالمنطقة الزمنية + التحويل. صغير، مفيد لجدولة الوكلاء.",
    "Query temporali con fuso orario + conversione. Piccolo, utile per programmare agenti."
  ],
  [
    "to add Anthropic-style SKILL.md packs, then give them to your agents (Agents tab → an agent → 📚 Skills).",
    " 添加 Anthropic 风格的 SKILL.md 包，然后将它们分配给你的代理（代理选项卡 → 一个代理 → 📚 技能）。",
    "Anthropic 스타일의 SKILL.md 패키지를 추가한 다음, 이를 에이전트에게 제공합니다 (에이전트 탭 → 에이전트 → 📚 기술).",
    "Anthropicスタイルの SKILL.md パックを追加し、それをエージェントに与えます（Agents タブ → エージェント → 📚 スキル）。",
    "لإضافة حزم SKILL.md على نمط Anthropic، ثم إعطائها لوكلائك (علامة تبويب Agents → وكيل → 📚 المهارات).",
    "per aggiungere pacchetti SKILL.md in stile Anthropic e poi darli ai tuoi agenti (Scheda Agenti → un agente → 📚 Competenze)."
  ],
  [
    "to apply.",
    "以应用。",
    "적용하기 위해.",
    "申請するため。",
    "للتطبيق.",
    "applicare."
  ],
  [
    "to find competitor products, prior art, documentation, or research.",
    "以查找竞争产品、现有技术、文档或研究。",
    "경쟁 제품, 선행 기술, 문서 또는 연구를 찾기 위해.",
    "競合製品、先行技術、ドキュメント、または研究を見つけるため。",
    "للعثور على منتجات المنافسين، أو الأعمال السابقة، أو الوثائق، أو البحوث.",
    "trovare prodotti concorrenti, arte precedente, documentazione o ricerche."
  ],
  [
    "to get the indexed list of interactive elements before clicking or filling.",
    "在点击或填写之前获取交互元素的索引列表。",
    "클릭하거나 입력하기 전에 대화형 요소의 인덱스된 목록을 얻기 위해.",
    "クリックや入力の前にインタラクティブ要素のインデックス付きリストを取得するため。",
    "للحصول على القائمة المفهرسة للعناصر التفاعلية قبل النقر أو الملء.",
    "ottenere l'elenco indicizzato degli elementi interattivi prima di fare clic o compilare."
  ],
  [
    "to load a template onto the canvas.",
    "将模板加载到画布上。",
    "캔버스에 템플릿을 로드하기 위해.",
    "テンプレートをキャンバスに読み込むため。",
    "لتحميل قالب على اللوحة.",
    "caricare un modello sulla tela."
  ],
  [
    "to load a template.",
    "加载一个模板。",
    "템플릿을 로드하기 위해.",
    "テンプレートを読み込むため。",
    "لتحميل قالب.",
    "caricare un modello."
  ],
  [
    "to point it at a local folder here.",
    "将它指向这里的本地文件夹。",
    "여기 로컬 폴더를 가리키기 위해.",
    "ここにあるローカルフォルダを指すため。",
    "لتوجيهه نحو مجلد محلي هنا.",
    "indirizzarlo su una cartella locale qui."
  ],
  [
    "to re-read the interactive elements.",
    "重新读取交互元素。",
    "대화형 요소를 다시 읽기 위해.",
    "インタラクティブ要素を再読み込みするため。",
    "لإعادة قراءة العناصر التفاعلية.",
    "rielaborare gli elementi interattivi."
  ],
  [
    "to switch on the Virtual Machine Platform. Until you reboot, Linux features stay unavailable and may feel slow. Save your work, then reboot — when you're back, open this dialog and the rest happens automatically.",
    "要开启虚拟机平台。在你重新启动之前，Linux 功能仍然不可用，并可能运行缓慢。保存你的工作，然后重启 — 当你返回时，打开此对话框，其余操作会自动进行。",
    "가상 머신 플랫폼을 켜기 위해. 재부팅할 때까지 Linux 기능을 사용할 수 없으며 느리게 느껴질 수 있습니다. 작업을 저장한 후 재부팅하세요 — 다시 돌아오면 이 대화 상자를 열고 나머지는 자동으로 진행됩니다.",
    "仮想マシンプラットフォームをオンにするため。再起動するまで、Linuxの機能は利用できず、動作が遅く感じる場合があります。作業を保存してから再起動してください。再起動後、このダイアログを開くと残りは自動的に行われます。",
    "لتشغيل منصة الجهاز الافتراضي. حتى تقوم بإعادة التشغيل، تبقى ميزات لينكس غير متوفرة وقد تبدو بطيئة. احفظ عملك، ثم أعد التشغيل — عند عودتك، افتح هذا الحوار وسيحدث الباقي تلقائيًا.",
    "attivare la Piattaforma della Macchina Virtuale. Fino al riavvio, le funzionalità di Linux rimangono non disponibili e possono sembrare lente. Salva il tuo lavoro, poi riavvia — quando torni, apri questa finestra e il resto avviene automaticamente."
  ],
  [
    "To use this skill:",
    "使用此技能：",
    "이 기능을 사용하기 위해:",
    "このスキルを使用するため：",
    "لاستخدام هذه المهارة:",
    "Per usare questa abilità:"
  ],
  [
    "TODOs, configuration references, anything by content.",
    "待办事项、配置参考、任何内容相关的信息。",
    "TODO, 구성 참조, 콘텐츠별 모든 것.",
    "TODO、設定参照、内容によるすべて。",
    "المهام القابلة للقيام بها، مراجع التكوين، أي شيء حسب المحتوى.",
    "TODO, riferimenti alla configurazione, qualsiasi cosa per contenuto."
  ],
  [
    "Together AI",
    "TOGETHER AI",
    "TOGETHER AI",
    "TOGETHER AI",
    "TOGETHER AI",
    "TOGETHER AI"
  ],
  [
    "TOGETHER AI",
    "一起 AI",
    "투게더 AI",
    "トゥゲザーAI",
    "معًا الذكاء الاصطناعي",
    "INSIEME AI"
  ],
  [
    "toggle decides whether it launches by itself. Auto-start servers don't start at app boot — they spin up lazily on the",
    "切换决定它是否会自行启动。自动启动服务器不会在应用启动时启动——它们会在需要时懒惰地启动",
    "토글은 그것이 스스로 실행될지를 결정합니다. 자동 시작 서버는 앱 부팅 시 시작되지 않으며 — 필요할 때 지연되어 실행됩니다",
    "トグルは自動起動するかどうかを決定します。自動起動サーバーはアプリの起動時には開始せず、必要に応じて遅延起動します。",
    "المفتاح يقرر ما إذا كان سيتم تشغيله بنفسه. الخوادم التي تبدأ تلقائيًا لا تبدأ عند فتح التطبيق — إنها تعمل بشكل تدريجي عند",
    "il toggle decide se si avvia da solo. I server ad avvio automatico non si avviano all'accensione dell'app — si avviano lentamente su"
  ],
  [
    "tok",
    "tok",
    "토크",
    "tok",
    "توك",
    "tok"
  ],
  [
    "Token:",
    "令牌：",
    "토큰:",
    "トークン:",
    "الرمز:",
    "Token:"
  ],
  [
    "tokens",
    "tokens",
    "토큰",
    "トークン",
    "الرموز",
    "tokens"
  ],
  [
    "Tokens: 0",
    "令牌：0",
    "토큰: 0",
    "トークン: 0",
    "الرموز: 0",
    "Token: 0"
  ],
  [
    "Too large for your GPU (search only)",
    "对你的 GPU 来说太大（仅限搜索）",
    "GPU에 너무 큽니다 (검색 전용)",
    "GPUには大きすぎます（検索のみ）",
    "كبير جدًا بالنسبة لوحدة معالجة الرسومات الخاصة بك (بحث فقط)",
    "Troppo grande per la tua GPU (solo ricerca)"
  ],
  [
    "tool",
    "工具",
    "도구",
    "ツール",
    "أداة",
    "strumento"
  ],
  [
    "Tool call",
    "工具调用",
    "도구 호출",
    "ツール呼び出し",
    "استدعاء الأداة",
    "Chiamata dello strumento"
  ],
  [
    "tool for any device you've paired and been granted",
    "您已配对并被授权的任何设备的工具",
    "페어링하고 권한을 받은 모든 장치용 도구",
    "ペアリング済みで許可された任意のデバイス用のツール",
    "أداة لأي جهاز قمت بإقرانه وحصلت على إذن له",
    "strumento per qualsiasi dispositivo che hai associato e a cui ti è stato concesso"
  ],
  [
    "Tool install failed: {0}",
    "工具安装失败：{0}",
    "도구 설치 실패: {0}",
    "ツールのインストールに失敗しました: {0}",
    "فشل تثبيت الأداة: {0}",
    "Installazione strumento fallita: {0}"
  ],
  [
    "Tools",
    "工具",
    "도구",
    "道具",
    "أدوات",
    "Strumenti"
  ],
  [
    "Tools · inherited from role '",
    "工具 · 继承自角色",
    "도구 · 역할에서 상속됨 ",
    "ツール · ロールから継承",
    "الأدوات · موروثة من الدور ",
    "Strumenti · ereditati dal ruolo "
  ],
  [
    "tools (from role)",
    "工具（来自角色）",
    "도구 (역할에서) ",
    "ツール（ロールから）",
    "الأدوات (من الدور)",
    "strumenti (dal ruolo)"
  ],
  [
    "Tools & content",
    "工具和内容",
    "도구 및 콘텐츠 ",
    "ツールとコンテンツ",
    "الأدوات والمحتوى",
    "Strumenti e contenuti"
  ],
  [
    "Tools are inherited from each agent's",
    "工具从每个代理继承",
    "도구는 각 에이전트에서 상속됩니다 ",
    "ツールは各エージェントから継承されます",
    "يتم وراثة الأدوات من كل وكيل",
    "Gli strumenti sono ereditati da ciascun agente"
  ],
  [
    "Tools can reach your files — only the write-jail and dangerous-command guard apply.",
    "工具可以访问你的文件 — 仅应用写入监狱和危险命令保护。",
    "도구는 파일에 접근할 수 있으며 — 쓰기-감옥(write-jail)과 위험한 명령(dangerous-command) 방어만 적용됩니다. ",
    "ツールはあなたのファイルにアクセスできます — 書き込み用の監獄と危険なコマンドガードのみが適用されます。",
    "يمكن للأدوات الوصول إلى ملفاتك — فقط حماية الكتابة في السجن والأوامر الخطرة تنطبق.",
    "Gli strumenti possono accedere ai tuoi file — si applicano solo le protezioni write-jail e comando pericoloso."
  ],
  [
    "total",
    "总计",
    "총계 ",
    "合計",
    "الإجمالي",
    "totale"
  ],
  [
    "Total queue time across started steps",
    "启动步骤的总排队时间",
    "시작된 단계 전체 대기 시간 ",
    "開始されたステップ全体の合計待ち時間",
    "إجمالي وقت الانتظار عبر الخطوات التي بدأت",
    "Tempo totale in coda tra i passaggi iniziati"
  ],
  [
    "training",
    "训练",
    "훈련 ",
    "トレーニング",
    "التدريب",
    "Formazione"
  ],
  [
    "Training",
    "培训",
    "훈련",
    "トレーニング",
    "تدريب",
    "Allenamento"
  ],
  [
    "Training log",
    "训练日志",
    "훈련 로그 ",
    "トレーニングログ",
    "سجل التدريب",
    "Registro di formazione"
  ],
  [
    "Training Logs",
    "训练日志",
    "훈련 로그 ",
    "トレーニングログ",
    "سجلات التدريب",
    "Registri di formazione"
  ],
  [
    "Training will use CPU (slower)",
    "训练将使用 CPU（较慢）",
    "훈련은 CPU를 사용합니다 (느림) ",
    "トレーニングはCPUを使用します（遅い）",
    "سيستخدم التدريب المعالج (أبطأ)",
    "La formazione utilizzerà la CPU (più lenta)"
  ],
  [
    "Transcribes audio attachments (Telegram, WhatsApp, in-app) into text for every agent path. Local — no cloud round-trip.",
    "将音频附件（Telegram、WhatsApp、应用内）转录为文本，适用于每个代理路径。本地处理 — 无云端往返。",
    "오디오 첨부파일(Telegram, WhatsApp, 앱 내)을 모든 에이전트 경로에 대해 텍스트로 기록합니다. 로컬 — 클라우드 왕복 없음.",
    "オーディオ添付ファイル（Telegram、WhatsApp、アプリ内）を各エージェントパスごとにテキストに書き起こします。ローカル — クラウド経由なし。",
    "ينقل المرفقات الصوتية (تيليجرام، واتساب، داخل التطبيق) إلى نص لجميع مسارات الوكلاء. محلي — بدون رحلة عبر السحابة.",
    "Trascrive gli allegati audio (Telegram, WhatsApp, in-app) in testo per ogni percorso dell'agente. Locale — nessun passaggio in cloud."
  ],
  [
    "transient chatter), put a line ANYWHERE in your reply in this exact form:",
    "短暂的聊天），在你的回复中任何地方放一行，形式完全如下：",
    "일시적인 수다), 답변 어디에든 정확히 이 형식으로 줄을 넣으십시오:",
    "一時的なおしゃべり）、返信のどこにでも次の形式で1行を入れてください: ",
    "الثرثرة العابرة)، ضع سطرًا في أي مكان في ردك بهذا الشكل بالضبط:",
    "chiacchiere transitorie), metti una linea OVUNQUE nella tua risposta in questa forma esatta:"
  ],
  [
    "tried to read a file",
    "尝试读取文件",
    "파일을 읽으려고 시도함",
    "ファイルを読み取ろうとしました",
    "حاول قراءة ملف",
    "ha provato a leggere un file"
  ],
  [
    "true to also return the secret CI env values. Default false (metadata only).",
    "true 也会返回秘密 CI 环境值。默认 false（仅元数据）。",
    "시크릿 CI 환경 값을 반환하도록 true 설정. 기본값은 false(메타데이터만).",
    "秘密のCI環境値も返すかどうか。デフォルトはfalse（メタデータのみ）。",
    "صحيح أيضًا لإرجاع قيم بيئة CI السرية. الافتراضي خطأ (البيانات الوصفية فقط).",
    "vero anche per restituire i valori segreti dell'ambiente CI. Predefinito falso (solo metadati)."
  ],
  [
    "Trust writes — agents edit files directly (skip the write guard).",
    "Trust 写入 — 代理直接编辑文件（跳过写入保护）。",
    "쓰기 신뢰 — 에이전트가 파일을 직접 편집함 (쓰기 보호 건너뜀).",
    "信頼された書き込み — エージェントがファイルを直接編集（書き込みガードをスキップ）。",
    "الثقة في الكتابة — يعمل الوكلاء على تعديل الملفات مباشرة (تجاوز حارس الكتابة).",
    "Scritture fidate — gli agenti modificano i file direttamente (salta la protezione di scrittura)."
  ],
  [
    "Trust writes — let the team edit files directly without the sandbox guard.",
    "Trust 写入 — 让团队在没有沙盒保护的情况下直接编辑文件。",
    "쓰기 신뢰 — 팀이 샌드박스 보호 없이 파일을 직접 편집하도록 허용.",
    "信頼された書き込み — チームがサンドボックスガードなしでファイルを直接編集できるようにする。",
    "الثقة في الكتابة — سمح للفريق بتحرير الملفات مباشرة دون حارس الصندوق الرمل.",
    "Scritture fidate — lascia che il team modifichi i file direttamente senza la protezione della sandbox."
  ],
  [
    "trusted",
    "受信任的",
    "신뢰됨",
    "信頼済み",
    "موثوق",
    "fidato"
  ],
  [
    "Trusted controllers & permissions",
    "受信任的控制器和权限",
    "신뢰할 수 있는 컨트롤러 및 권한",
    "信頼されたコントローラーと権限",
    "المتحكمون والأذونات الموثوق بهم",
    "Controller e permessi affidabili"
  ],
  [
    "trusted LAN",
    "受信任的局域网",
    "신뢰할 수 있는 LAN",
    "信頼されたLAN",
    "شبكة محلية موثوقة",
    "LAN fidata"
  ],
  [
    "Try again",
    "再试一次",
    "다시 시도",
    "再試行",
    "حاول مرة أخرى",
    "Riprova"
  ],
  [
    "tuned",
    "已调优",
    "조정됨",
    "調整済み",
    "محسّن",
    "ottimizzato"
  ],
  [
    "TUNED (LOCAL)",
    "已调优（本地）",
    "조정됨(로컬)",
    "調整済み（ローカル）",
    "محسّن (محلي)",
    "OTTIMIZZATO (LOCALE)"
  ],
  [
    "Turn Auto mode OFF",
    "关闭自动模式",
    "자동 모드 끄기",
    "自動モードをOFFにする",
    "إيقاف وضع التشغيل التلقائي",
    "Disattiva modalità Auto"
  ],
  [
    "Turn Auto mode ON",
    "开启自动模式",
    "자동 모드 켜기",
    "自動モードをONにする",
    "تشغيل وضع التشغيل التلقائي",
    "Attiva modalità Auto"
  ],
  [
    "Turn OFF",
    "关闭",
    "끄기",
    "オフにする",
    "أوقف التشغيل",
    "SPEGNI"
  ],
  [
    "Turn ON",
    "开启",
    "켜기",
    "オンにする",
    "شغّل",
    "ACCENDI"
  ],
  [
    "turns · ~",
    "轮次 · ~",
    "회전 · ~",
    "回転 · ~",
    "يدور · ~",
    "colpi · ~"
  ],
  [
    "Tutorial recorder",
    "教程录制器",
    "튜토리얼 녹화기",
    "チュートリアルレコーダー",
    "مسجل الدروس التعليمية",
    "Registratore del Tutorial"
  ],
  [
    "Tutorial Recorder",
    "教程录制器",
    "튜토리얼 레코더",
    "チュートリアルレコーダー",
    "مسجل الدروس",
    "Registratore di tutorial"
  ],
  [
    "tvly-…",
    "tvly-…",
    "tvly-…",
    "tvly-…",
    "tvly-…",
    "tvly-…"
  ],
  [
    "Type something to send",
    "输入内容以发送",
    "보낼 내용을 입력하세요",
    "送信する内容を入力",
    "اكتب شيئًا لإرساله",
    "Digita qualcosa per inviare"
  ],
  [
    "Type text into the input/textarea element at the given index from the latest",
    "在最新索引的输入/文本区域元素中输入文本",
    "최근 항목에서 지정된 인덱스의 입력/텍스트 영역 요소에 텍스트를 입력하세요",
    "最新の入力/テキストエリア要素の指定されたインデックスにテキストを入力",
    "اكتب نصًا في عنصر الإدخال / منطقة النص عند الفهرس المحدد من الأحدث",
    "Digita testo nell'elemento input/textarea all'indice dato dall'ultimo"
  ],
  [
    "Type your message here...",
    "在此输入您的消息...",
    "여기에 메시지를 입력하세요...",
    "ここにメッセージを入力...",
    "اكتب رسالتك هنا...",
    "Digita qui il tuo messaggio..."
  ],
  [
    "Type your request while the workspace finishes preparing…",
    "在工作区完成准备时输入您的请求…",
    "작업 공간 준비가 완료되는 동안 요청을 입력하세요…",
    "ワークスペースの準備が完了する間にリクエストを入力してください…",
    "اكتب طلبك بينما ينتهي مساحة العمل من التحضير...",
    "Digita la tua richiesta mentre lo spazio di lavoro termina la preparazione…"
  ],
  [
    "UAC prompt",
    "UAC 提示",
    "UAC 프롬프트",
    "UAC プロンプト",
    "موجه UAC",
    "Prompt UAC"
  ],
  [
    "Ubuntu",
    "Ubuntu",
    "우분투",
    "Ubuntu",
    "أوبونتو",
    "Ubuntu"
  ],
  [
    "Ubuntu is installed",
    "已安装 Ubuntu",
    "우분투가 설치됨",
    "Ubuntu がインストールされています",
    "تم تثبيت أوبونتو",
    "Ubuntu è installato"
  ],
  [
    "Ubuntu is installed but has no Linux user yet — create your account so environments install under your home (not root).",
    "Ubuntu 已安装但尚无 Linux 用户 — 请创建您的账户，以便环境安装在您的主目录下（而非 root）。",
    "우분투가 설치되어 있지만 아직 Linux 사용자가 없습니다 — 환경을 홈 디렉토리(루트가 아닌)에 설치하려면 계정을 생성하세요.",
    "Ubuntu はインストールされていますが、まだ Linux ユーザーがいません — 環境をホームディレクトリ（root ではなく）にインストールするためにアカウントを作成してください。",
    "تم تثبيت أوبونتو لكنه لا يحتوي على مستخدم لينكس بعد — أنشئ حسابك حتى يتم تثبيت البيئات تحت مجلد المنزل الخاص بك (وليس الجذر).",
    "Ubuntu è installato ma non ha ancora un utente Linux — crea il tuo account così gli ambienti si installano sotto la tua home (non root)."
  ],
  [
    "Ubuntu is installed but has no user account yet. Pick a name and password — we create the account for you (no console window) and remember it",
    "Ubuntu 已安装但尚无用户帐户。请选择一个名字和密码——我们将为您创建帐户（无控制台窗口）并记住它",
    "우분투가 설치되었지만 아직 사용자 계정이 없습니다. 이름과 비밀번호를 선택하세요 — 계정을 만들어 드립니다 (콘솔 창 없음) 그리고 이를 기억합니다",
    "Ubuntuはインストールされていますが、まだユーザーアカウントがありません。名前とパスワードを選んでください — アカウントを作成します（コンソールウィンドウはありません）そしてそれを記憶します",
    "تم تثبيت أوبونتو ولكن لا يوجد حساب مستخدم بعد. اختر اسمًا وكلمة مرور — سنقوم بإنشاء الحساب لك (بدون نافذة وحدة التحكم) وتذكرهما",
    "Ubuntu è installato ma non ha ancora un account utente. Scegli un nome e una password — creiamo l'account per te (nessuna finestra della console) e lo ricordiamo"
  ],
  [
    "uname -a",
    "uname -a",
    "uname -a",
    "uname -a",
    "uname -a",
    "uname -a"
  ],
  [
    "Uncommitted changes vs HEAD",
    "相对于 HEAD 的未提交更改",
    "커밋되지 않은 변경 사항 vs HEAD",
    "HEADに対する未コミットの変更",
    "تغييرات غير مُرتكبة مقابل HEAD",
    "Modifiche non confermate rispetto a HEAD"
  ],
  [
    "Unequip",
    "卸下",
    "장비 해제",
    "解除",
    "إزالة التجهيز",
    "Rimuovi equipaggiamento"
  ],
  [
    "Unfiltered Answer",
    "未过滤答案",
    "필터링되지 않은 답변",
    "無フィルターの回答",
    "إجابة غير مصفية",
    "Risposta non filtrata"
  ],
  [
    "Uninstall",
    "卸载",
    "제거",
    "アンインストール",
    "إلغاء التثبيت",
    "Disinstalla"
  ],
  [
    "uninstall failed: {0}",
    "卸载失败：{0}",
    "제거 실패: {0}",
    "アンインストールに失敗しました: {0}",
    "فشل إلغاء التثبيت: {0}",
    "Disinstallazione fallita: {0}"
  ],
  [
    "Uninstall failed: {0}",
    "卸载失败：{0}",
    "제거 실패: {0}",
    "アンインストールに失敗しました: {0}",
    "فشل إلغاء التثبيت: {0}",
    "Disinstallazione non riuscita: {0}"
  ],
  [
    "Unpin",
    "取消固定",
    "고정 해제",
    "ピン留め解除",
    "إلغاء التثبيت الثابت",
    "Sblocca"
  ],
  [
    "unsaved",
    "未保存",
    "저장되지 않음",
    "保存されていない",
    "غير محفوظ",
    "non salvato"
  ],
  [
    "Unsigned",
    "未签名",
    "서명되지 않음",
    "署名なし",
    "غير موقع",
    "Non firmato"
  ],
  [
    "unsupported",
    "不支持",
    "지원되지 않음",
    "サポートされていません",
    "غير مدعوم",
    "non supportato"
  ],
  [
    "update available",
    "有更新可用",
    "업데이트 가능",
    "アップデート可能",
    "تحديث متوفر",
    "aggiornamento disponibile"
  ],
  [
    "Update failed.",
    "更新失败。",
    "업데이트 실패.",
    "更新に失敗しました。",
    "فشل التحديث.",
    "Aggiornamento fallito."
  ],
  [
    "Update the selected saved template with the current system prompt",
    "使用当前系统提示更新所选的已保存模板",
    "선택한 저장된 템플릿을 현재 시스템 프롬프트로 업데이트",
    "現在のシステムプロンプトで選択した保存済みテンプレートを更新する",
    "تحديث القالب المحفوظ المحدد باستخدام المطالبة الحالية للنظام",
    "Aggiorna il modello salvato selezionato con il prompt di sistema corrente"
  ],
  [
    "Updated:",
    "已更新：",
    "업데이트됨:",
    "更新済み:",
    "تم التحديث:",
    "Aggiornato:"
  ],
  [
    "uppercase",
    "大写",
    "대문자",
    "大文字",
    "الحروف الكبيرة",
    "MAIUSCOLO"
  ],
  [
    "url",
    "网址",
    "URL",
    "URL",
    "رابط",
    "url"
  ],
  [
    "URL to navigate to (web or localhost).",
    "要导航到的URL（网页或本地主机）。",
    "이동할 URL (웹 또는 로컬호스트).",
    "移動するURL（ウェブまたはローカルホスト）。",
    "الرابط للتنقل إليه (الويب أو المضيف المحلي).",
    "URL a cui navigare (web o localhost)."
  ],
  [
    "URL to open (e.g. https://example.com or localhost:5173).",
    "要打开的URL（例如 https://example.com 或 localhost:5173）。",
    "열 URL (예: https://example.com 또는 localhost:5173).",
    "開くURL（例: https://example.com または localhost:5173）。",
    "الرابط للفتح (مثل https://example.com أو localhost:5173).",
    "URL da aprire (es. https://example.com o localhost:5173)."
  ],
  [
    "URL where the MCP server listens. External clients point at this URL.",
    "MCP服务器监听的URL。外部客户端指向此URL。",
    "MCP 서버가 수신하는 URL. 외부 클라이언트는 이 URL을 가리킵니다.",
    "MCPサーバーが待機しているURL。外部クライアントはこのURLを指定する。",
    "الرابط الذي يستمع عنده خادم MCP. يشير العملاء الخارجيون إلى هذا الرابط.",
    "URL dove il server MCP ascolta. I client esterni si collegano a questo URL."
  ],
  [
    "Usage",
    "使用",
    "사용법",
    "使用法",
    "الاستخدام",
    "Uso"
  ],
  [
    "Use",
    "使用",
    "사용",
    "使用",
    "الاستخدام",
    "Usare"
  ],
  [
    "Use {0} ({1}:{2}) from your account",
    "从您的账户使用 {0} ({1}:{2})",
    "계정에서 {0} ({1}:{2}) 사용",
    "アカウントから {0} ({1}:{2}) を使用する",
    "استخدم {0} ({1}:{2}) من حسابك",
    "Usa {0} ({1}:{2}) dal tuo account"
  ],
  [
    "Use a",
    "使用一个",
    "a 사용",
    "使用する",
    "استخدم a",
    "Usa un"
  ],
  [
    "Use for training",
    "用于训练",
    "훈련에 사용",
    "トレーニングに使用する",
    "استخدم للتدريب",
    "Usa per l'addestramento"
  ],
  [
    "Use this environment for training runs",
    "在训练运行中使用此环境",
    "훈련 실행을 위해 이 환경 사용",
    "トレーニング実行用にこの環境を使用する",
    "استخدم هذا البيئة لجلسات التدريب",
    "Usa questo ambiente per le sessioni di addestramento"
  ],
  [
    "Use this on URLs returned by web_search to extract feature lists,",
    "在 web_search 返回的网址上使用它以提取功能列表",
    "웹_search에서 반환된 URL에서 기능 목록을 추출하는 데 사용",
    "web_search で返されたURLで使用して、特徴リストを抽出する",
    "استخدم هذا على الروابط التي تم إرجاعها بواسطة البحث على الويب لاستخراج قوائم الميزات،",
    "Usa questo sugli URL restituiti da web_search per estrarre elenchi di funzionalità,"
  ],
  [
    "Use this to discover files when you don't yet know their content.",
    "在你还不知道文件内容时，使用此方法来发现文件。",
    "아직 파일 내용을 모를 때 파일을 발견하는 데 사용",
    "内容がまだ分からないファイルを発見するためにこれを使用する",
    "استخدم هذا لاكتشاف الملفات عندما لا تعرف محتواها بعد.",
    "Usa questo per scoprire file quando non conosci ancora il loro contenuto."
  ],
  [
    "Use to read article/body content rather than the interactive-element list.",
    "用于阅读文章/正文内容，而不是交互元素列表。",
    "대화형 요소 목록보다는 기사/본문 내용을 읽는 데 사용합니다.",
    "インタラクティブ要素リストではなく、記事/本文の内容を読むために使用します。",
    "استخدم لقراءة المقال / محتوى الجسم بدلاً من قائمة العناصر التفاعلية.",
    "Usa per leggere articoli/contenuti del corpo piuttosto che l'elenco degli elementi interattivi."
  ],
  [
    "Used tool: {0}",
    "使用的工具：{0}",
    "사용된 도구: {0}",
    "使用したツール: {0}",
    "الأداة المستخدمة: {0}",
    "Strumento usato: {0}"
  ],
  [
    "user",
    "用户",
    "사용자",
    "ユーザー",
    "المستخدم",
    "utente"
  ],
  [
    "User Input history",
    "用户输入历史",
    "사용자 입력 기록",
    "ユーザー入力履歴",
    "سجل مدخلات المستخدم",
    "Cronologia input utente"
  ],
  [
    "Username",
    "用户名",
    "사용자 이름",
    "ユーザー名",
    "اسم المستخدم",
    "Nome utente"
  ],
  [
    "username (admin)",
    "用户名（管理员）",
    "사용자 이름 (관리자)",
    "ユーザー名（管理者）",
    "اسم المستخدم (المسؤول)",
    "username (admin)"
  ],
  [
    "username / email",
    "用户名 / 邮箱",
    "사용자 이름 / 이메일",
    "ユーザー名 / メール",
    "اسم المستخدم / البريد الإلكتروني",
    "username / email"
  ],
  [
    "Uses MCP:",
    "使用 MCP：",
    "MCP 사용:",
    "MCPを使用",
    "يستخدم MCP:",
    "Usa MCP:"
  ],
  [
    "Using Your Local LLM with External Tools",
    "使用本地 LLM 结合外部工具",
    "외부 도구와 함께 로컬 LLM 사용",
    "外部ツールと一緒にローカルLLMを使用",
    "استخدام نموذج اللغة المحلي الخاص بك مع الأدوات الخارجية",
    "Uso del tuo LLM locale con strumenti esterni"
  ],
  [
    "uv",
    "uv",
    "uv",
    "uv",
    "uv",
    "uv"
  ],
  [
    "uvx",
    "uvx",
    "uvx",
    "uvx",
    "uvx",
    "uvx"
  ],
  [
    "values — for Apple: APPLE_CERTIFICATE (base64 .p12), APPLE_CERTIFICATE_PASSWORD, APPLE_SIGNING_IDENTITY,",
    "值 — 对于 Apple：APPLE_CERTIFICATE（base64 .p12）、APPLE_CERTIFICATE_PASSWORD、APPLE_SIGNING_IDENTITY，",
    "값 — Apple의 경우: APPLE_CERTIFICATE (base64 .p12), APPLE_CERTIFICATE_PASSWORD, APPLE_SIGNING_IDENTITY,",
    "値 — Appleの場合: APPLE_CERTIFICATE（base64 .p12）、APPLE_CERTIFICATE_PASSWORD、APPLE_SIGNING_IDENTITY",
    "القيم — لأبل: APPLE_CERTIFICATE (base64 .p12)، APPLE_CERTIFICATE_PASSWORD، APPLE_SIGNING_IDENTITY،",
    "valori — per Apple: APPLE_CERTIFICATE (base64 .p12), APPLE_CERTIFICATE_PASSWORD, APPLE_SIGNING_IDENTITY,"
  ],
  [
    "values carefully: never echo them into logs, commits, or chat.",
    "仔细处理值：切勿将它们回显到日志、提交或聊天中。",
    "값을 주의 깊게 사용: 절대로 이를 로그, 커밋 또는 채팅에 출력하지 마세요.",
    "値を注意深く扱う: ログ、コミット、チャットに絶対に出力しない",
    "تعامل مع القيم بحذر: لا تُدرجها أبدًا في السجلات أو الالتزامات أو الدردشة.",
    "valori con attenzione: non inserirli mai nei log, nei commit o in chat."
  ],
  [
    "variables.",
    "变量。",
    "변수.",
    "変数.",
    "المتغيرات.",
    "variabili."
  ],
  [
    "Verify command",
    "验证命令",
    "명령 확인",
    "コマンドを確認",
    "تحقق من الأمر",
    "Verifica comando"
  ],
  [
    "Verifying signature and swapping the binary. The app will restart in a moment.",
    "正在验证签名并交换二进制文件。应用程序将很快重新启动。",
    "서명 확인 및 바이너리 교체 중입니다. 앱이 곧 다시 시작됩니다.",
    "署名を確認してバイナリを入れ替えています。アプリはまもなく再起動します。",
    "التحقق من التوقيع واستبدال الملف الثنائي. سيعاد تشغيل التطبيق بعد لحظة.",
    "Verifica della firma e sostituzione del file binario. L'app si riavvierà tra un momento."
  ],
  [
    "Version",
    "版本",
    "버전",
    "バージョン",
    "الإصدار",
    "Versione"
  ],
  [
    "Version file",
    "版本文件",
    "버전 파일",
    "バージョンファイル",
    "ملف الإصدار",
    "File di versione"
  ],
  [
    "via your package manager. Then reload this page.",
    "通过您的包管理器。然后重新加载此页面。",
    "패키지 관리자를 통해. 그런 다음 이 페이지를 다시 로드하십시오.",
    "パッケージマネージャーを通じて。その後、このページをリロードしてください。",
    "عبر مدير الحزم الخاص بك. ثم أعد تحميل هذه الصفحة.",
    "tramite il tuo gestore di pacchetti. Poi ricarica questa pagina."
  ],
  [
    "video",
    "视频",
    "비디오",
    "ビデオ",
    "فيديو",
    "video"
  ],
  [
    "View + drive the agents' shared web browser (browser_* tools) — see the live page, open URLs, stop the daemon.",
    "查看并操作代理的共享网页浏览器（browser_* 工具）——查看实时页面，打开 URL，停止守护进程。",
    "에이전트의 공유 웹 브라우저(browser_* 도구)를 보기 및 조작 — 실시간 페이지 보기, URL 열기, 데몬 중지.",
    "エージェントの共有ウェブブラウザ（browser_* ツール）を表示および操作 — ライブページを確認、URLを開く、デーモンを停止。",
    "عرض + تشغيل متصفح الويب المشترك للوكلاء (أدوات browser_*) — راجع الصفحة المباشرة، افتح الروابط، أوقف المشغل.",
    "Visualizza e controlla il browser web condiviso dagli agenti (strumenti browser_*) — vedi la pagina live, apri URL, ferma il demone."
  ],
  [
    "View diff",
    "查看差异",
    "차이 보기",
    "差分を表示",
    "عرض الاختلاف",
    "Visualizza differenze"
  ],
  [
    "View on GitHub",
    "在 GitHub 上查看",
    "GitHub에서 보기",
    "GitHubで表示",
    "عرض على GitHub",
    "Visualizza su GitHub"
  ],
  [
    "View:",
    "查看：",
    "보기:",
    "表示:",
    "عرض:",
    "Vista:"
  ],
  [
    "Voice",
    "语音",
    "음성",
    "音声",
    "الصوت",
    "Voce"
  ],
  [
    "Voice of the user — reviews the orchestrator's plan. Always present, advisory.",
    "用户的声音——审查协调器的计划。始终存在，提供建议。",
    "사용자의 음성 — 오케스트레이터의 계획 검토. 항상 존재하며, 조언 역할.",
    "ユーザーの声 — オーケストレーターの計画をレビュー。常に存在し、助言を提供。",
    "صوت المستخدم — يراجع خطة المنظم. حاضر دائمًا، استشاري.",
    "Voce dell'utente — rivede il piano dell'orchestratore. Sempre presente, consultiva."
  ],
  [
    "Voice of the user. Reviews the orchestrator's plan, answers [NEED_USER_INPUT] when Director Mode is on.",
    "用户的声音。审查编排者的计划，在导演模式开启时回答 [NEED_USER_INPUT]。",
    "사용자 음성. 오케스트레이터의 계획을 검토하고, 디렉터 모드가 켜져 있을 때 [NEED_USER_INPUT]에 답변합니다.",
    "ユーザーの声。オーケストレーターの計画を確認し、ディレクターモードがオンのときに[NEED_USER_INPUT]で応答します。",
    "صوت المستخدم. يراجع خطة المنسق، يجيب [NEED_USER_INPUT] عندما يكون وضع المدير مفعلًا.",
    "Voce dell'utente. Rivede il piano dell'orchestratore, risponde [NEED_USER_INPUT] quando la Modalità Direttore è attiva."
  ],
  [
    "Voice runtime ·",
    "语音运行时 ·",
    "음성 런타임 ·",
    "音声ランタイム ·",
    "وقت تشغيل الصوت ·",
    "Runtime vocale ·"
  ],
  [
    "VPN/SSH tunnel",
    "VPN/SSH 隧道",
    "VPN/SSH 터널",
    "VPN/SSHトンネル",
    "نفق VPN/SSH",
    "Tunnel VPN/SSH"
  ],
  [
    "VRAM",
    "显存",
    "VRAM",
    "VRAM",
    "ذاكرة الفيديو (VRAM)",
    "VRAM"
  ],
  [
    "VRAM: N/A",
    "显存：不适用",
    "VRAM: 해당 없음",
    "VRAM: 該当なし",
    "ذاكرة الفيديو: غير متوفرة",
    "VRAM: N/D"
  ],
  [
    "Waiting for training process to start…",
    "等待训练过程开始…",
    "학습 프로세스 시작 대기 중…",
    "トレーニングプロセスの開始を待っています…",
    "في انتظار بدء عملية التدريب…",
    "In attesa dell'avvio del processo di addestramento…"
  ],
  [
    "Waiting for you to authorize…",
    "等待您授权…",
    "승인 대기 중…",
    "あなたの許可を待っています…",
    "في انتظار تفويضك…",
    "In attesa della tua autorizzazione…"
  ],
  [
    "wants to control this machine.",
    "想要控制此机器。",
    "이 기계를 제어하려고 합니다.",
    "このマシンを操作したいです。",
    "يريد التحكم في هذا الجهاز.",
    "vuole controllare questa macchina."
  ],
  [
    "wants to run a",
    "想要运行一个",
    "실행하려고 하는",
    "実行したいです",
    "يريد تشغيل",
    "vuole eseguire un"
  ],
  [
    "warming up model",
    "正在预热模型",
    "모델 워밍업",
    "モデルをウォーミングアップ中",
    "تسخين النموذج",
    "riscaldamento del modello"
  ],
  [
    "warning",
    "警告",
    "경고",
    "警告",
    "تحذير",
    "avviso"
  ],
  [
    "watcher",
    "观察者",
    "감시자",
    "ウォッチャー",
    "المراقب",
    "osservatore"
  ],
  [
    "Watcher Observatory",
    "观察者天文台",
    "워처 관측소",
    "ウォッチャー観測所",
    "مرصد المراقب",
    "Osservatorio Watcher"
  ],
  [
    "We opened",
    "我们打开了",
    "열었습니다",
    "私たちは開きました",
    "لقد فتحنا",
    "Abbiamo aperto"
  ],
  [
    "Web search via Brave Search API. Free 2000 q/mo but now requires a card to verify.",
    "通过 Brave Search API 的网页搜索。每月免费 2000 次查询，但现在需要绑定信用卡进行验证。",
    "Brave Search API를 통한 웹 검색. 월 2000회 무료 검색 가능하지만, 현재는 카드 인증이 필요합니다.",
    "Brave Search API経由のウェブ検索。月2000クエリまで無料ですが、現在は確認のためカードが必要です。",
    "البحث على الويب عبر واجهة برمجة تطبيقات Brave Search. 2000 سؤال مجاني شهريًا ولكن الآن يتطلب بطاقة للتحقق.",
    "Ricerca web tramite Brave Search API. Gratis 2000 query/mese ma ora richiede una carta per la verifica."
  ],
  [
    "Web search via DuckDuckGo. NO key, NO card, unlimited. Requires `uvx` (Astral uv) — install via `winget install astral-sh.uv` or `pip install uv`, then restart OwLLM.",
    "通过 DuckDuckGo 进行网络搜索。无需密钥，无需信用卡，无限使用。需要 `uvx`（Astral uv）——通过 `winget install astral-sh.uv` 或 `pip install uv` 安装，然后重启 OwLLM。",
    "DuckDuckGo를 통한 웹 검색. 키 없음, 카드 없음, 무제한. `uvx`(Astral uv) 필요 — `winget install astral-sh.uv` 또는 `pip install uv`로 설치 후 OwLLM을 재시작하세요.",
    "DuckDuckGoを介したウェブ検索。キー不要、カード不要、無制限。`uvx`（Astral uv）が必要 — `winget install astral-sh.uv` または `pip install uv` を使ってインストールし、その後OwLLMを再起動してください。",
    "البحث على الويب عبر DuckDuckGo. لا مفتاح، لا بطاقة، غير محدود. يتطلب `uvx` (Astral uv) — قم بالتثبيت عبر `winget install astral-sh.uv` أو `pip install uv`، ثم أعد تشغيل OwLLM.",
    "Ricerca sul web tramite DuckDuckGo. NESSUNA chiave, NESSUNA carta, illimitato. Richiede `uvx` (Astral uv) — installa tramite `winget install astral-sh.uv` o `pip install uv`, poi riavvia OwLLM."
  ],
  [
    "Web-only · sign up to subscribe",
    "仅限网络 · 注册订阅",
    "웹 전용 · 구독하려면 가입",
    "ウェブ専用 · 購読サインアップ",
    "متاح على الويب فقط · اشترك للتسجيل",
    "Solo web · iscriviti per abbonarti"
  ],
  [
    "Website / Web app",
    "网站 / 网络应用",
    "웹사이트 / 웹 앱",
    "ウェブサイト / ウェブアプリ",
    "الموقع الإلكتروني / تطبيق الويب",
    "Sito web / App web"
  ],
  [
    "weight matrix against that direction.",
    "反向该方向的权重矩阵。",
    "그 방향에 대한 가중치 행렬.",
    "その方向に対する重み行列。",
    "مصفوفة الوزن ضد ذلك الاتجاه.",
    "matrice dei pesi contro quella direzione."
  ],
  [
    "Weights on disk",
    "磁盘上的权重",
    "디스크에 저장된 가중치",
    "ディスク上の重み",
    "الأوزان على القرص",
    "Pesi su disco"
  ],
  [
    "Welcome to OwLLM",
    "欢迎使用 OwLLM",
    "OwLLM에 오신 것을 환영합니다",
    "OwLLMへようこそ",
    "مرحبًا بك في OwLLM",
    "Benvenuto in OwLLM"
  ],
  [
    "What did you do, what did you expect, what happened? This is what the team reads first.",
    "你做了什么，你期望什么，发生了什么？这是团队首先查看的内容。",
    "무엇을 했고, 무엇을 기대했고, 무슨 일이 일어났나요? 팀이 가장 먼저 읽는 내용입니다.",
    "あなたは何をしましたか、何を期待しましたか、何が起こりましたか？これはチームが最初に読む内容です。",
    "ماذا فعلت، ماذا كنت تتوقع، ماذا حدث؟ هذا ما يقرأه الفريق أولاً.",
    "Cosa hai fatto, cosa ti aspettavi, cosa è successo? Questo è ciò che il team legge per primo."
  ],
  [
    "What do you want to make? Pick a card — the right team of agents and settings are prepared for you. You can adjust everything afterwards.",
    "你想制作什么？选择一张卡片 —— 已为你准备好了合适的代理团队和设置。之后你可以调整所有内容。",
    "무엇을 만들고 싶나요? 카드를 선택하세요 — 적합한 팀과 설정이 준비되어 있습니다. 이후 모든 것을 조정할 수 있습니다.",
    "何を作りたいですか？カードを選んでください — 適切なエージェントチームと設定があなたのために用意されています。後で全て調整することができます。",
    "ماذا تريد أن تصنع؟ اختر بطاقة — الفريق المناسب من الوكلاء والإعدادات جاهز من أجلك. يمكنك تعديل كل شيء لاحقًا.",
    "Cosa vuoi creare? Scegli una carta — il giusto team di agenti e impostazioni è pronto per te. Puoi regolare tutto successivamente."
  ],
  [
    "What is abliteration?",
    "什么是消除？",
    "Abliteration이란 무엇인가요?",
    "abliterationとは何ですか？",
    "ما هو التلاشي؟",
    "Cos'è l'abliterazione?"
  ],
  [
    "What it does",
    "它的作用",
    "그것이 하는 일",
    "その機能",
    "ماذا يفعل",
    "Cosa fa"
  ],
  [
    "What this agent does on the team",
    "该代理在团队中所做的事情",
    "이 에이전트가 팀에서 하는 일",
    "このエージェントがチームで行うこと",
    "ما يفعله هذا الوكيل في الفريق",
    "Cosa fa questo agente nel team"
  ],
  [
    "What this agent is here to achieve — its objective on the team.",
    "这个代理在这里要实现的目标——它在团队中的任务。",
    "이 에이전트가 여기서 달성하려는 것 — 팀 내에서의 목표.",
    "このエージェントがここで達成しようとしていること — チームにおけるその目的。",
    "ما يسعى هذا الوكيل لتحقيقه هنا — هدفه داخل الفريق.",
    "Cosa questo agente è qui per ottenere — il suo obiettivo nel team."
  ],
  [
    "What this project is, in one or two lines — the team reads this.",
    "这个项目是什么，用一两行说明——团队会阅读这个。",
    "이 프로젝트가 무엇인지, 한두 줄로 — 팀에서 읽습니다.",
    "このプロジェクトが何であるか、1～2行で — チームはこれを読む。",
    "ما هذا المشروع، في سطر أو سطرين — يقرأ الفريق هذا.",
    "Cos'è questo progetto, in una o due righe — il team lo legge."
  ],
  [
    "What this team is for",
    "这个团队的目的",
    "이 팀이 존재하는 이유",
    "このチームの目的",
    "ما الغرض من هذا الفريق",
    "A cosa serve questo team"
  ],
  [
    "What you get",
    "你将获得的",
    "얻는 것",
    "得られるもの",
    "ما تحصل عليه",
    "Cosa ottieni"
  ],
  [
    "What's new",
    "新内容",
    "새로운 소식",
    "新着情報",
    "ما الجديد",
    "Cosa c'è di nuovo"
  ],
  [
    "WhatsApp",
    "WhatsApp",
    "왓츠앱",
    "WhatsApp",
    "واتساب",
    "WhatsApp"
  ],
  [
    "When a goal says “publish”, the release runs by rule: bump → commit → tag → push, then either build locally or let GitHub Actions finish it.",
    "当目标标记为“发布”时，发布按规则运行：bump → 提交 → 标签 → 推送，然后要么在本地构建，要么让 GitHub Actions 完成。",
    "목표가 “발행”이라고 말할 때, 릴리스는 규칙에 따라 실행됩니다: bump → commit → tag → push, 그 후 로컬에서 빌드하거나 GitHub Actions가 끝내도록 합니다.",
    "目標が「公開」と言う場合、リリースはルールに従って実行されます：バンプ → コミット → タグ → プッシュ、その後、ローカルでビルドするか、GitHub Actionsに終了させる。",
    "عندما يقول الهدف 'نشر'، يتم تنفيذ الإصدار وفق القاعدة: زيادة → التزام → وسم → دفع، ثم إما البناء محليًا أو ترك GitHub Actions لإكماله.",
    "Quando un obiettivo dice “pubblica”, la release procede per regola: incremento → commit → tag → push, poi o costruisci localmente o lasci che GitHub Actions la completi."
  ],
  [
    "When a run finishes cleanly, the next pending step is dispatched automatically — write the roadmap, the team walks it. Only the page that turns this on feeds the queue.",
    "当一次运行顺利完成时，下一个待处理步骤会自动派发——撰写路线图，团队按照执行。只有启用此功能的页面会提供队列。",
    "실행이 정상적으로 끝나면, 다음 대기 단계가 자동으로 실행됩니다 — 로드맵을 작성하고 팀이 진행합니다. 이를 켜는 페이지만 큐를 공급합니다.",
    "実行が正常に終了すると、次の保留中のステップが自動的に送信されます — ロードマップを書き、チームが進めます。これをオンにするページだけがキューにフィードされます。",
    "عندما تنتهي عملية تشغيل بنجاح، يتم إرسال الخطوة التالية المعلقة تلقائيًا — كتابة خارطة الطريق، يسير الفريق عليها. فقط الصفحة التي تفعل هذا تُغذي قائمة الانتظار.",
    "Quando un'esecuzione termina correttamente, il passo successivo in sospeso viene inviato automaticamente — scrivi la roadmap, il team la percorre. Solo la pagina che attiva questo alimenta la coda."
  ],
  [
    "When on, your agents (Agentic team / Code) get a",
    "当开启时，你的代理（Agentic 团队 / 代码）会得到一个",
    "켜져 있을 때, 당신의 에이전트들(Agentic 팀 / 코드)은",
    "オンの時、あなたのエージェント（Agenticチーム / コード）は",
    "عند التشغيل، يحصل عملاؤك (فريق Agentic / الكود) على",
    "Quando è attivo, i tuoi agenti (team Agentic / Codice) ottengono un"
  ],
  [
    "When the 1st agent finishes a reply, automatically feed it to the 2nd agent as its next turn.",
    "当第一个代理完成回复时，自动将其作为第二个代理的下一轮输入。",
    "첫 번째 에이전트가 답장을 완료하면, 자동으로 그 답장을 두 번째 에이전트의 다음 턴으로 전달합니다.",
    "最初のエージェントが返信を終えたら、それを自動的に2番目のエージェントに次のターンとして送る。",
    "عندما ينهي العميل الأول الرد، يُغذى تلقائيًا إلى العميل الثاني كدور له التالي.",
    "Quando il primo agente termina una risposta, inviala automaticamente al secondo agente come il suo turno successivo."
  ],
  [
    "When the 2nd agent finishes a reply, automatically feed it to the 1st agent as its next turn.",
    "当第二个代理完成回复时，自动将其作为第一个代理的下一轮输入。",
    "두 번째 에이전트가 답장을 완료하면, 자동으로 그 답장을 첫 번째 에이전트의 다음 턴으로 전달합니다.",
    "2番目のエージェントが返信を終えたら、それを自動的に1番目のエージェントに次のターンとして送る。",
    "عندما ينهي العميل الثاني الرد، يُغذى تلقائيًا إلى العميل الأول كدور له التالي.",
    "Quando il secondo agente termina una risposta, inviala automaticamente al primo agente come il suo turno successivo."
  ],
  [
    "when the project is born.",
    "当项目诞生时。",
    "프로젝트가 시작될 때.",
    "プロジェクトが生まれたとき。",
    "عندما يولد المشروع.",
    "quando il progetto nasce."
  ],
  [
    "Where am I?",
    "我在哪里？",
    "내가 어디에 있지?",
    "私はどこにいますか？",
    "أين أنا؟",
    "Dove sono?"
  ],
  [
    "Which signing set: 'apple' (default) or 'windows'.",
    "签名集：'apple'（默认）还是 'windows'。",
    "어떤 서명 세트: 'apple' (기본값) 또는 'windows'.",
    "どのサインセット： 'apple'（デフォルト）または 'windows'。",
    "أي مجموعة توقيع: 'apple' (افتراضي) أو 'windows'.",
    "Quale set di firma: 'apple' (predefinito) o 'windows'."
  ],
  [
    "whisper-cpp",
    "whisper-cpp",
    "whisper-cpp",
    "whisper-cpp",
    "whisper-cpp",
    "whisper-cpp"
  ],
  [
    "whisper.cpp binary",
    "whisper.cpp 二进制文件",
    "whisper.cpp 바이너리",
    "whisper.cpp バイナリ",
    "ثنائي whisper.cpp",
    "file binario whisper.cpp"
  ],
  [
    "whoami",
    "whoami",
    "whoami",
    "whoami",
    "من أنا",
    "whoami"
  ],
  [
    "Windows",
    "Windows",
    "Windows",
    "Windows",
    "ويندوز",
    "Windows"
  ],
  [
    "Windows — Authenticode",
    "Windows — Authenticode",
    "Windows — Authenticode",
    "Windows — Authenticode",
    "ويندوز — Authenticode",
    "Windows — Authenticode"
  ],
  [
    "Windows cert mounted",
    "Windows 证书已挂载",
    "Windows 인증서 장착됨",
    "Windows 証明書マウント済み",
    "شهادة ويندوز مركبة",
    "Certificato Windows montato"
  ],
  [
    "Windows cert NOT in store",
    "Windows 证书未在存储中",
    "Windows 인증서가 저장소에 없음",
    "Windows 証明書がストアにない",
    "شهادة ويندوز غير موجودة في المخزن",
    "Certificato Windows NON in archivio"
  ],
  [
    "Windows cert: unknown",
    "Windows 证书：未知",
    "Windows 인증서: 알 수 없음",
    "Windows 証明書: 不明",
    "شهادة Windows: غير معروفة",
    "Certificato Windows: sconosciuto"
  ],
  [
    "Windows:",
    "Windows：",
    "Windows:",
    "Windows:",
    "ويندوز:",
    "Windows:"
  ],
  [
    "Wipe the local clone and re-clone from scratch",
    "清除本地克隆并从头重新克隆",
    "로컬 클론을 삭제하고 처음부터 다시 클론하기",
    "ローカルクローンを消去して、最初から再クローンする",
    "امسح النسخة المحلية وأعد النسخ من البداية",
    "Cancella la copia locale e riclonala da zero"
  ],
  [
    "Wipe the log panel above. Doesn't affect the running servers.",
    "清除上方日志面板。不会影响正在运行的服务器。",
    "위의 로그 패널을 지우기. 실행 중인 서버에는 영향 없음.",
    "上のログパネルを消去する。実行中のサーバーには影響しない。",
    "امسح لوحة السجل أعلاه. لا يؤثر على الخوادم العاملة.",
    "Cancella il pannello dei log sopra. Non influisce sui server in esecuzione."
  ],
  [
    "with browser_click / browser_fill / browser_select — ALWAYS call this first to",
    "使用 browser_click / browser_fill / browser_select — 始终先调用此方法来",
    "browser_click / browser_fill / browser_select 사용 시 — 항상 먼저 호출하기",
    "browser_click / browser_fill / browser_select を使う場合 — まず必ずこれを呼び出す",
    "مع browser_click / browser_fill / browser_select — دائماً استدعي هذا أولاً ل",
    "con browser_click / browser_fill / browser_select — CHIAMA SEMPRE questo prima di"
  ],
  [
    "working",
    "工作中",
    "작동 중",
    "動作中",
    "قيد العمل",
    "in funzione"
  ],
  [
    "Working notes",
    "工作笔记",
    "작업 메모",
    "作業ノート",
    "ملاحظات العمل",
    "Note di lavoro"
  ],
  [
    "Working on {0} ({1})",
    "正在处理 {0} ({1})",
    "{0} ({1}) 작업 중",
    "{0} ({1}) に取り組んでいる",
    "العمل على {0} ({1})",
    "Lavorando su {0} ({1})"
  ],
  [
    "Working tree clean",
    "工作树干净",
    "작업 트리 깨끗함",
    "作業ディレクトリはクリーン",
    "شجرة العمل نظيفة",
    "Albero di lavoro pulito"
  ],
  [
    "worklog",
    "工作日志",
    "작업 기록",
    "作業ログ",
    "سجل العمل",
    "registro attività"
  ],
  [
    "Works for the public web AND local dev servers (localhost:5173, 127.0.0.1:3000",
    "适用于公共网络和本地开发服务器 (localhost:5173, 127.0.0.1:3000)",
    "공용 웹 및 로컬 개발 서버(localhost:5173, 127.0.0.1:3000)에서 작동함",
    "パブリックウェブとローカル開発サーバー（localhost:5173、127.0.0.1:3000）の両方で動作",
    "يعمل مع الويب العام وخوادم التطوير المحلية (localhost:5173, 127.0.0.1:3000)",
    "Funziona per il web pubblico E per i server locali di sviluppo (localhost:5173, 127.0.0.1:3000"
  ],
  [
    "Workspace folder the MCP tools (shell, file ops, git) operate inside.",
    "MCP 工具（shell、文件操作、git）操作的工作空间文件夹。",
    "MCP 도구들(쉘, 파일 작업, git)이 작동하는 작업 공간 폴더",
    "MCP ツール（シェル、ファイル操作、git）が操作するワークスペースフォルダ",
    "مجلد مساحة العمل الذي تعمل داخله أدوات MCP (الشل، عمليات الملفات، git).",
    "Cartella di lavoro in cui operano gli strumenti MCP (shell, operazioni sui file, git)."
  ],
  [
    "Workspace still preparing — Send unlocks in a moment.",
    "工作区仍在准备中——稍后发送解锁。",
    "작업 공간이 아직 준비 중 — 잠시 후 잠금을 보냅니다.",
    "作業スペースはまだ準備中 — すぐにアンロックを送信します。",
    "المساحة العملية لا تزال قيد التحضير — سيتم إرسال فتح القفل بعد لحظة.",
    "Workspace in preparazione — Invia gli sblocchi tra un momento."
  ],
  [
    "Write a step and press Enter…",
    "写一个步骤并按回车…",
    "단계를 작성하고 Enter를 누르세요…",
    "ステップを書いてEnterを押します…",
    "اكتب خطوة واضغط إدخال…",
    "Scrivi un passaggio e premi Invio…"
  ],
  [
    "writes and edits code",
    "编写和编辑代码",
    "코드를 작성하고 수정합니다",
    "コードの作成と編集",
    "يكتب ويحرر الشيفرة",
    "scrive e modifica codice"
  ],
  [
    "Writes the six",
    "写六个",
    "여섯을 작성합니다",
    "六つを書きます",
    "يكتب الستة",
    "Scrive i sei"
  ],
  [
    "writes to (decisions, conventions, build/run commands, file locations,",
    "写入（决策、约定、构建/运行命令、文件位置，",
    "(decisions, conventions, 빌드/실행 명령, 파일 위치에) 작성합니다",
    "（決定、規約、ビルド/実行コマンド、ファイルの場所へ）書きます",
    "يكتب إلى (القرارات، الاتفاقيات، أوامر البناء/التشغيل، مواقع الملفات،",
    "scrive a (decisioni, convenzioni, comandi di build/run, posizioni dei file,"
  ],
  [
    "writes user-facing and developer docs",
    "编写面向用户和开发者的文档",
    "사용자와 개발자를 위한 문서를 작성합니다",
    "ユーザー向けおよび開発者向けドキュメントを書きます",
    "يكتب وثائق موجهة للمستخدم والمطور",
    "scrive documentazione per utenti e sviluppatori"
  ],
  [
    "Writing & content",
    "写作与内容",
    "작성 및 콘텐츠",
    "執筆 & コンテンツ",
    "الكتابة والمحتوى",
    "Scrittura e contenuti"
  ],
  [
    "wsl",
    "WSL",
    "WSL",
    "WSL",
    "WSL",
    "WSL"
  ],
  [
    "WSL",
    "WSL",
    "WSL",
    "WSL",
    "WSL",
    "WSL"
  ],
  [
    "WSL commands",
    "WSL 命令",
    "WSL 명령어",
    "WSLコマンド",
    "أوامر WSL",
    "Comandi WSL"
  ],
  [
    "WSL needs a quick setup first.",
    "WSL 需要先快速设置。",
    "WSL은 먼저 빠른 설정이 필요합니다.",
    "WSLは最初に簡単な設定が必要です。",
    "يحتاج WSL إلى إعداد سريع أولاً.",
    "WSL necessita prima di una configurazione rapida."
  ],
  [
    "WSL note: Win11 mirrored networking can use loopback (exposure off); Win10 (NAT) needs this ON.",
    "WSL 注释：Win11 镜像网络可以使用回环（曝光关闭）；Win10（NAT）需要开启此功能。",
    "WSL 참고: Win11 미러링 네트워킹은 루프백 사용 가능(노출 꺼짐); Win10(NAT)은 이것을 켜야 합니다.",
    "WSLメモ: Win11のミラーリングネットワークはループバック使用可能（公開オフ）；Win10（NAT）はこれをONにする必要があります。",
    "ملاحظة WSL: يمكن للشبكات المعكوسة في Win11 استخدام حلقة العودة (التعرض مغلق)؛ Win10 (NAT) يحتاج هذا مُفعل.",
    "Nota WSL: il networking mirror di Win11 può usare il loopback (esposizione disattivata); Win10 (NAT) necessita di attivarlo."
  ],
  [
    "WSL setup log",
    "WSL 设置日志",
    "WSL 설정 로그",
    "WSL設定ログ",
    "سجل إعداد WSL",
    "Log configurazione WSL"
  ],
  [
    "WSL was installed, but Windows needs",
    "WSL 已安装，但 Windows 需要",
    "WSL이 설치되었지만, Windows는",
    "WSLはインストールされましたが、Windowsが必要です",
    "تم تثبيت WSL، ولكن يحتاج Windows إلى",
    "WSL è stato installato, ma Windows ha bisogno"
  ],
  [
    "wsl-restart",
    "wsl-restart",
    "wsl-restart가 필요합니다",
    "wsl-再起動",
    "wsl-restart",
    "wsl-restart"
  ],
  [
    "xAI · GROK",
    "xAI · GROK",
    "xAI · GROK",
    "xAI · GROK",
    "xAI · GROK",
    "xAI · GROK"
  ],
  [
    "xAI Grok",
    "xAI Grok",
    "xAI Grok",
    "xAI グロック",
    "xAI Grok",
    "xAI Grok"
  ],
  [
    "xapp-… (Socket Mode, connections:write)",
    "xapp-…（Socket 模式，连接：写入）",
    "xapp-… (소켓 모드, 연결:쓰기)",
    "xapp-…（ソケットモード、接続：書き込み）",
    "xapp-… (وضع المقبس، الاتصالات: كتابة)",
    "xapp-… (Modalità Socket, connessioni: scrittura)"
  ],
  [
    "xoxb-…",
    "xoxb-…",
    "xoxb-…",
    "xoxb-…",
    "xoxb-…",
    "xoxb-…"
  ],
  [
    "xoxb-… (chat:write, files:read)",
    "xoxb-…（聊天：写入，文件：读取）",
    "xoxb-… (채팅:쓰기, 파일:읽기)",
    "xoxb-…（チャット:書き込み、ファイル:読み取り）",
    "xoxb-… (الدردشة: كتابة، الملفات: قراءة)",
    "xoxb-… (chat: scrittura, file: lettura)"
  ],
  [
    "XP",
    "XP",
    "XP",
    "XP",
    "XP",
    "XP"
  ],
  [
    "xxxx-xxxx-xxxx-xxxx",
    "xxxx-xxxx-xxxx-xxxx",
    "xxxx-xxxx-xxxx-xxxx",
    "xxxx-xxxx-xxxx-xxxx",
    "xxxx-xxxx-xxxx-xxxx",
    "xxxx-xxxx-xxxx-xxxx"
  ],
  [
    "Yes",
    "是",
    "예",
    "はい",
    "نعم",
    "Sì"
  ],
  [
    "Yes, permanently delete",
    "是，永久删除",
    "예, 영구적으로 삭제",
    "はい、完全に削除する",
    "نعم، احذف نهائيًا",
    "Sì, elimina permanentemente"
  ],
  [
    "yet — then follow its instructions. You may call it again with a",
    "然而 — 然后按照它的指示操作。你可以再次调用它，用一个",
    "그러나 그 다음에는 지침을 따르십시오. 다시 호출할 때는",
    "しかし — その指示に従ってください。また、次のように呼び出すことができます",
    "بعد ذلك — اتبع تعليماته. يمكنك استدعاؤه مرة أخرى باستخدام",
    "ancora — quindi segui le sue istruzioni. Puoi richiamarlo con un"
  ],
  [
    "you",
    "你",
    "당신",
    "あなた",
    "أنت",
    "TU"
  ],
  [
    "YOU",
    "你",
    "당신",
    "あなた",
    "أنت",
    "TU"
  ],
  [
    "you've paired and granted shell to. Unlike ssh_exec this needs NO SSH keys/config",
    "你已配对并授予 shell 权限。与 ssh_exec 不同，这不需要 SSH 密钥/配置",
    "당신이 페어링하고 셸 권한을 부여한 위치. ssh_exec과 달리 이 경우 SSH 키/설정이 필요 없습니다",
    "あなたがペアリングしてシェルを付与したものです。ssh_execとは違い、これはSSHキーや設定を一切必要としません",
    "لقد قمت بالربط ومنحت الصدفة له. على عكس ssh_exec هذا لا يحتاج إلى مفاتيح/إعدادات SSH",
    "hai accoppiato e concesso shell. A differenza di ssh_exec questo NON richiede chiavi/configurazioni SSH"
  ],
  [
    "you@example.com",
    "you@example.com",
    "you@example.com",
    "you@example.com",
    "you@example.com",
    "tu@example.com"
  ],
  [
    "Your Accounts logins sync into the sandbox automatically and persist.",
    "您的账户登录信息会自动同步到沙箱中，并且会保留。",
    "귀하의 계정 로그인은 자동으로 샌드박스에 동기화되며 유지됩니다.",
    "あなたのアカウントのログイン情報はサンドボックスに自動的に同期され、保持されます。",
    "تتزامن تسجيلات دخول حساباتك تلقائيًا مع البيئة التجريبية وتستمر.",
    "I tuoi login degli account si sincronizzano automaticamente nel sandbox e persistono."
  ],
  [
    "Your agents",
    "您的代理",
    "귀하의 에이전트",
    "あなたのエージェント",
    "وكلاؤك",
    "I tuoi agenti"
  ],
  [
    "Your chats & setup, on every device — stored in your own GitHub.",
    "您的聊天记录和设置，在每个设备上——存储在您自己的 GitHub 上。",
    "모든 기기에서 여러분의 채팅 및 설정 — 여러분의 GitHub에 저장됩니다.",
    "あなたのチャットと設定は、すべてのデバイスで — 自分のGitHubに保存されます。",
    "دردشاتك وإعداداتك، على كل جهاز — مخزنة في GitHub الخاص بك.",
    "Le tue chat e impostazioni, su ogni dispositivo — archiviate nel tuo GitHub."
  ],
  [
    "Your idea (one or two sentences — be generic, the brainstormer fills in the rest)",
    "你的创意（一两句话——保持通用，由头脑风暴者补充其余部分）",
    "귀하의 아이디어(한두 문장 — 일반적으로, 브레인스토머가 나머지를 채웁니다)",
    "あなたのアイデア（1〜2文 — 一般的な内容で、ブレインストーマーが残りを補完します）",
    "فكرتك (جملة واحدة أو جملتان — بشكل عام، يقوم صاحب الأفكار ببقية التفاصيل)",
    "La tua idea (una o due frasi — essere generici, il creativo completa il resto)"
  ],
  [
    "Your local AI coding workspace — open a folder and your model reads, searches, edits and runs commands right inside it.",
    "你本地的 AI 编码工作空间——打开一个文件夹，你的模型就在其中读取、搜索、编辑并执行命令。",
    "귀하의 로컬 AI 코딩 작업 공간 — 폴더를 열면 귀하의 모델이 그 안에서 읽고, 검색하고, 수정하며 명령을 실행합니다.",
    "あなたのローカルAIコーディングワークスペース — フォルダを開くと、モデルがその中で読み取り、検索、編集、コマンド実行を行います。",
    "مساحة عملك المحلية لبرمجة الذكاء الاصطناعي — افتح مجلدًا ونموذجك يقرأ ويبحث ويحرر ويشغّل الأوامر بداخله مباشرة.",
    "Il tuo spazio di lavoro di codifica AI locale — apri una cartella e il tuo modello legge, cerca, modifica ed esegue comandi direttamente al suo interno."
  ],
  [
    "Your local model codes directly in",
    "您的本地模型直接编码于",
    "귀하의 로컬 모델이 직접 코딩합니다",
    "あなたのローカルモデルは直接コードを書きます",
    "نموذجك المحلي يبرمج مباشرة في",
    "Il tuo modello locale codice direttamente in"
  ],
  [
    "your model has the memory_write tool, calling it does the same thing.",
    "你的模型有 memory_write 工具，调用它效果相同。",
    "귀하의 모델에는 memory_write 도구가 있으며, 이를 호출하면 동일한 작업이 수행됩니다.",
    "あなたのモデルには memory_write ツールがあり、それを呼び出すと同じことが行われます。",
    "نموذجك لديه أداة memory_write، والاستخدامها يفعل الشيء نفسه.",
    "il tuo modello ha lo strumento memory_write, chiamarlo fa la stessa cosa."
  ],
  [
    "Your model works directly in this project — reading, searching, editing files and running commands. The conversation and plan are saved and return when you reopen it.",
    "你的模型可以直接在这个项目中工作——读取、搜索、编辑文件和运行命令。对话和计划会被保存，并在你重新打开时返回。",
    "귀하의 모델은 이 프로젝트에서 직접 작동합니다 — 파일 읽기, 검색, 편집 및 명령 실행이 가능합니다. 대화와 계획은 저장되며 다시 열면 불러옵니다.",
    "あなたのモデルはこのプロジェクトで直接動作します ― ファイルの読み取り、検索、編集、コマンドの実行が可能です。会話や計画は保存され、再度開いたときに返ってきます。",
    "يعمل نموذجك مباشرة في هذا المشروع — قراءة، بحث، تحرير الملفات وتشغيل الأوامر. يتم حفظ المحادثة والخطة وتعود عند إعادة فتحها.",
    "Il tuo modello funziona direttamente in questo progetto — leggendo, cercando, modificando file ed eseguendo comandi. La conversazione e il piano vengono salvati e ritornano quando lo riapri."
  ],
  [
    "Your other OwLLM machines publish their device records through your GitHub vault, so 🔄 Discover will keep coming back empty until you connect GitHub (or create a free account). Manual \"Pair by IP\" below works without it.",
    "你的其他 OwLLM 设备通过你的 GitHub 金库发布它们的设备记录，所以 🔄 发现功能会一直显示为空，直到你连接 GitHub（或创建一个免费账号）。下面的手动“按 IP 配对”可以在不连接的情况下使用。",
    "다른 OwLLM 장치들은 GitHub 금고를 통해 장치 기록을 게시하므로, GitHub에 연결하지 않거나 무료 계정을 만들기 전까지 🔄 Discover는 계속 비어 있게 됩니다. 아래 수동 \"IP로 연결\"은 GitHub 없이도 작동합니다.",
    "他の OwLLM マシンは GitHub ボルトを通じてデバイス記録を公開するので、GitHub に接続するまで（または無料アカウントを作成するまで）🔄「発見」は空のままになります。下の「IPでペアリング」手動操作は接続なしでも動作します。",
    "تنشر أجهزتك الأخرى من OwLLM سجلات الأجهزة الخاصة بها عبر خزنتك على GitHub، لذلك ستظل 🔄 اكتشف تظهر فارغة حتى تقوم بربط GitHub (أو إنشاء حساب مجاني). تعمل ميزة \"الإقران حسب IP\" اليدوي أدناه بدونها.",
    "Le tue altre macchine OwLLM pubblicano i loro record dei dispositivi attraverso il tuo vault GitHub, quindi 🔄 Discover continuerà a restare vuoto finché non colleghi GitHub (o crei un account gratuito). La modalità manuale \"Abbina per IP\" qui sotto funziona senza di esso."
  ],
  [
    "Your private vault",
    "你的私人保管库",
    "귀하의 개인 금고",
    "あなたのプライベートボルト",
    "خزنتك الخاصة",
    "Il tuo vault privato"
  ],
  [
    "Your sent messages will appear here. Type them in the Orchestrator's User Input dock below.",
    "你发送的消息将显示在这里。请在 Orchestrator 的用户输入窗口下方输入。",
    "보낸 메시지는 여기 표시됩니다. 아래 Orchestrator의 사용자 입력 도크에 입력하세요.",
    "送信したメッセージはここに表示されます。以下のオーケストレーターのユーザー入力ドックに入力してください。",
    "ستظهر رسائلك المرسلة هنا. اكتبها في لوحة إدخال المستخدم الخاصة بالمنسق أدناه.",
    "I tuoi messaggi inviati appariranno qui. Digitali nel dock di Input Utente dell'Orchestrator qui sotto."
  ],
  [
    "Your workspace's team ID (starts with T). Find at slack.com/admin/settings.",
    "你工作区的团队 ID（以 T 开头）。可在 slack.com/admin/settings 查找。",
    "작업 공간의 팀 ID(T로 시작)를 입력하세요. slack.com/admin/settings에서 확인할 수 있습니다.",
    "あなたのワークスペースのチーム ID（T で始まります）。slack.com/admin/settings で確認してください。",
    "معرف فريق مساحة عملك (يبدأ بـ T). ابحث عنه على slack.com/admin/settings.",
    "L'ID del team del tuo workspace (inizia con T). Trovalo su slack.com/admin/settings."
  ],
  [
    "Zoom in",
    "放大",
    "확대",
    "ズームイン",
    "تكبير",
    "Zoom avanti"
  ],
  [
    "Zoom out",
    "缩小",
    "축소",
    "ズームアウト",
    "تصغير",
    "Zoom indietro"
  ]
] as const;
export const UI_CATALOG_COVERAGE = {"zh-CN":2781,"ko":2781,"ja":2781,"ar":2781,"it":2781} as const;
