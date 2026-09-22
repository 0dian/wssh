using System;

// Stands in for a hypothetical future herdr build that HAS grown Windows
// `terminal attach` support (for A2). Compiled to a real .exe so it can be
// spawned directly (no shell) exactly like the real herdr.exe -- distinguishes
// the probe call (attach against the nonexistent sentinel term id, replies
// with a plain "not found" message so termrover-attach classifies it as
// official) from a real attach call (prints a marker + exits 7 so the test
// can tell this binary, not the shim, produced the output).
class FakeHerdrOfficial
{
    static int Main(string[] args)
    {
        string term = null;
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == "attach") { term = args[i + 1]; break; }
        }
        if (term == "__termrover_probe_nonexistent__")
        {
            Console.WriteLine("terminal target __termrover_probe_nonexistent__ not found");
            return 0;
        }
        Console.WriteLine("OFFICIAL_ATTACH_OK");
        return 7;
    }
}
