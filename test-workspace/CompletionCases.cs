using System;
using System.Collections.Generic;

// Phase 1.0 test harness — no SharpSense logic yet, only activation + manual checks.
// Each region is a manual verification case for later phases (1.1/1.2).

public class CompletionCases<T>
{
    public event EventHandler Changed;

    // 1. Plain method invocation: type DoSome| and accept -> expect DoSomething(|) + signature help
    public void DoSomething(int x, string y) { }

    // 2. Generic method: non-inferrable -> GetComp<$1>($2), inferrable -> omit <>
    public static T GetComponent<T>(string name) => default!;

    // 3. Constructor: new List<string>| -> new List<string>(|) + overload help
    public void ConstructorCase()
    {
        List<int> numbers = new List<int>(6);
    }

    // 4. Callback / += suppression: expect bare identifier, NO parens
    public void CallbackCase()
    {
        Changed += OnChanged; // Works
    }

    private void OnChanged(object? s, EventArgs e) { }

    // 5. nameof suppression: expect bare identifier, NO parens
    public void NameOfCase()
    {
        var n = nameof(DoSomething); // works
    }

    // 6. Attribute: [MyAttr|] -> bare identifier unless args required
    [MyAttr]
    public void AttributeTarget() { }

    // 7. Existing trailing parens: Foo(|) or Foo|() must never become Foo()()
    public void ExistingParensCase()
    {
        DoSomething(1, "Hi there!");
    }


    // 8. Definition vs invocation: void Foo| (definition) must NOT get call-site parens
    public void DefinitionShouldNotExpand() { }
}

public class MyAttrAttribute : Attribute { }

// 9. Unity message methods (definitions must NOT get call-site parens treatment in Phase 1.2+)
#if UNITY
public class PlayerController : UnityEngine.MonoBehaviour
{
    void Start() { }
    void Update() { }
}
#endif

// 10. Postfix trials (Phase 1.4): place cursor after each trigger word and
// accept the SharpSense postfix item, e.g. `user.var`, `user.if`, `count.for`.
public class PostfixCases
{
    public string GetUser(int id) => "user";
    public List<string> GetUsers() => new List<string>(4);
    public Task<string> LoadAsync() => Task.FromResult("x");// Some methods are generic but they may not need the <>... We must support them as well.
    public void Trials()
    {
        var user = GetUser(1);
        var users = GetUsers(); 
        // user.var | user.if | user.null | user.notnull | user.return
        //  users.foreach | users.for | LoadAsync().await | user.throw | user.switch
    }
}


public class TestClass
{
    private List<int> numbers;

    public TestClass()
    {
        numbers = new List<int>();
    }

    public Random CreateRnd()
    {
       return new Random();
    }

}