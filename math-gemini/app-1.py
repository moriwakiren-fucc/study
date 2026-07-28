import streamlit as st
from google import genai
from google.genai import types
from google.genai import errors
from PIL import Image

# --------------------------------------------------
# 1. システムプロンプトの設定
# --------------------------------------------------
SYSTEM_INSTRUCTION = """
## 質問者の状況
私は、高校数学の教科書内容を全て学習し終えた、難関大学への合格を目指す理系の高校3年生です。

## 解答者の条件
あなたは、数学が苦手な私を、大学合格へ導く数学の優秀な教育者です。

## 行動
問題が入力されたら、次の手順通りに教えてください。

## 手順
1. まず、入力された問題を読み取ってください。問題が複数ある場合は、1問づつ分けた上で、以下手順を問題ごとに繰り返してください。
2. 入力された問題を解くために必要な、教科書レベルの基礎知識を説明してください。
3. 入力された問題を解く上での考え方を教えてください。
4. 入力された問題の模範解答を、ステップに分けて作成してください。
5. なぜその解法を選択したのか、その解法を選択する必然性を教えてください。その際、間違って選択してしまいがちな別の解法があれば、それを全て挙げて、それらはなぜ使用できないのか、どのような条件ならその解法を使用するかも解説してください。

## 注意事項
- 数式を出力する際は、必ずLaTeX形式（$ ... $ または $$ ... $$）を使用してください。
- 三角関数は、sin, cos, tanのみを使用してください。sec, csc, cotなどは使用しないでください。
- 計算は丁寧にしてください。計算ミスは許されません。
- 記述解答を作る際、減点のない、完璧な答案を書いてください。
- 「解法の必然性」は、別の問題を解くときに再現性があるように、丁寧に詳しく書いてください。
"""

# --------------------------------------------------
# 2. ページ基本設定
# --------------------------------------------------
st.set_page_config(
    page_title="数学解説Gemini (APIキー要求版)",
    page_icon="📐",
    layout="wide"
)

st.title("📐 数学解説Gemini")
st.caption("ユーザー自身のAPIキーを利用するバージョンです (Powered by Gemini 1.5 Pro)")

# --------------------------------------------------
# 3. セッション状態の初期化
# --------------------------------------------------
if "chat" not in st.session_state:
    st.session_state.chat = None
if "messages" not in st.session_state:
    st.session_state.messages = []
if "current_problem_text" not in st.session_state:
    st.session_state.current_problem_text = ""
if "current_problem_image" not in st.session_state:
    st.session_state.current_problem_image = None
if "cached_api_key" not in st.session_state:
    st.session_state.cached_api_key = ""

# --------------------------------------------------
# 4. サイドバー：APIキー設定と問題入力
# --------------------------------------------------
with st.sidebar:
    st.header("🔑 APIキーの設定")
    
    api_key_input = st.text_input(
        "Gemini APIキーを入力してください", 
        value=st.session_state.cached_api_key,
        type="password",
        placeholder="AIzaSy..."
    )
    
    save_key_checkbox = st.checkbox("APIキーをこのブラウザに記憶する", value=True)
    
    if save_key_checkbox:
        st.session_state.cached_api_key = api_key_input
    else:
        st.session_state.cached_api_key = ""

    # 初心者向けのAPIキー取得手順（折りたたみ）
    with st.expander("🔰 APIキーの取得方法（無料）", expanded=False):
        st.markdown("""
        **「APIキー」** とは、AIを使うための **自分専用の合言葉（パスワード）** のようなものです。
        Googleアカウントを持っていれば、以下の手順で**誰でも無料で**取得できます。

        1. [Google AI Studio](https://aistudio.google.com/app/apikey) にアクセスします。
        2. お持ちの **Googleアカウントでログイン** します。
           （利用規約の画面が出たら、チェックを入れて「続行」を押してください）
        3. 画面の右上あたりにある青いボタン **「APIキーを作成」** をクリックします。
        4. 続いて上から2つ目の枠 **「インポートしたプロジェクトを選択」** → **「新しいプロジェクト」** の順にクリックします。
        5. 「プロジェクトの名前」を入力します。`Gemmath`などでよいと思います。入力後、「プロジェクトを作成」を押します。
        6. **「キーを作成」** を押してしばらく待つと **「APIキー」** という長い文字列が表示されます。
        6. 文字列の横にある **コピーボタン** を押してキーをコピーし、左側の入力欄に貼り付けてください。

        ⚠️ **注意**: このキーは自分専用のパスワードと同じです。他人に教えたり、SNSに公開したりしないようご注意ください。
        """)

    st.divider()

    st.header("📝 新しい問題を解く")
    st.write("テキスト入力、または画像のアップロードで問題を指定してください。")
    
    with st.form(key="new_problem_form", clear_on_submit=True):
        uploaded_file = st.file_uploader("📸 問題の画像（任意）", type=["png", "jpg", "jpeg"])
        new_problem_input = st.text_area(
            "✍️ 数学の問題（補足など）",
            height=150,
            placeholder="例: 画像の(2)だけを解説してください。"
        )
        submit_button = st.form_submit_button("この問題を解説させる")

# --------------------------------------------------
# 5. アプリのメインロジック（APIキーがない場合はここでストップ）
# --------------------------------------------------
if not api_key_input:
    st.info("↖️ サイドバー》を開いて（既に開かれている場合もあります）、ご自身のGemini APIキーを入力してスタートしてください。\n\n※取得方法は左側の「🔰 APIキーの取得方法（無料）」を開いて確認できます。")
    st.stop()

# APIクライアントの初期化（ユーザーのキーを使用）
client = genai.Client(api_key=api_key_input)

# 問題が送信された時の処理
if submit_button and (new_problem_input.strip() or uploaded_file is not None):
    img = None
    if uploaded_file is not None:
        img = Image.open(uploaded_file)
        
    st.session_state.current_problem_text = new_problem_input.strip()
    st.session_state.current_problem_image = img
    st.session_state.messages = []
    
    st.session_state.chat = client.chats.create(
        model="gemini-1.5-pro",
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM_INSTRUCTION,
            temperature=0.2, 
        )
    )
    
    initial_prompt_text = "以下の問題を指示通りの手順で解説してください。\n\n"
    if st.session_state.current_problem_text:
        initial_prompt_text += f"【テキスト・指示】\n{st.session_state.current_problem_text}\n"
    if img:
        initial_prompt_text += "【画像】\n添付した画像の問題を解いてください。"
        
    prompt_parts = [initial_prompt_text]
    if img is not None:
        prompt_parts.append(img)
    
    st.session_state.messages.append({
        "role": "user", 
        "content": initial_prompt_text,
        "image": img
    })
    
    with st.spinner("AIが解答と解説を生成中です..."):
        try:
            response = st.session_state.chat.send_message(prompt_parts)
            st.session_state.messages.append({
                "role": "assistant", 
                "content": response.text,
                "image": None
            })
            st.rerun()
        except errors.APIError as e:
            if e.code == 429:
                st.error("⚠️ **APIの利用制限に達しました。** 少し時間を置いてから再度お試しください。")
            elif e.code == 400 and "API key not valid" in str(e):
                st.error("⚠️ **無効なAPIキーです。** 取得したキーが正しく貼り付けられているか確認してください。")
            else:
                st.error(f"⚠️ APIエラーが発生しました: {e.message}")
        except Exception as e:
            st.error(f"⚠️ 予期せぬエラーが発生しました: {e}")

# --------------------------------------------------
# 6. メイン画面の表示と追加チャット機能
# --------------------------------------------------
if not st.session_state.current_problem_text and st.session_state.current_problem_image is None:
    st.info("👈 左側のサイドバーから数学の問題を入力、またはアップロードしてください。")
else:
    for message in st.session_state.messages:
        with st.chat_message(message["role"]):
            if message.get("image") is not None:
                st.image(message["image"], caption="アップロードされた問題", width=400)
            st.markdown(message["content"])

    if prompt := st.chat_input("この解説について質問や気になる点があれば入力してください..."):
        st.session_state.messages.append({"role": "user", "content": prompt, "image": None})
        with st.chat_message("user"):
            st.markdown(prompt)

        with st.chat_message("assistant"):
            with st.spinner("思考中..."):
                try:
                    response = st.session_state.chat.send_message(prompt)
                    st.markdown(response.text)
                    st.session_state.messages.append({"role": "assistant", "content": response.text, "image": None})
                except errors.APIError as e:
                    if e.code == 429:
                        st.error("⚠️ **APIの利用制限に達しました。** 少し時間を置いてから再度お試しください。")
                    else:
                        st.error(f"⚠️ APIエラーが発生しました: {e.message}")
                except Exception as e:
                    st.error(f"⚠️ 予期せぬエラーが発生しました: {e}")
